"""SQL Warehouse connector wrapping databricks.sdk.

Mirrors packages/appkit/src/connectors/sql-warehouse/client.ts
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from typing import Any

import httpx
import pyarrow as pa
import pyarrow.ipc as ipc
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import (
    Disposition,
    Format,
    StatementParameterListItem,
    StatementResponse,
    StatementState,
)

logger = logging.getLogger("appkit.connector.sql")

# States that indicate the query is still running
_PENDING_STATES = {StatementState.PENDING, StatementState.RUNNING}
_FAILED_STATES = {StatementState.FAILED, StatementState.CANCELED, StatementState.CLOSED}


def decode_arrow_attachment(attachment_b64: str) -> list[dict[str, Any]]:
    """Decode a base64 Arrow IPC attachment into row dicts.

    Mirrors the TS _transformArrowAttachment: base64 → Arrow IPC → row objects.
    """
    buf = base64.b64decode(attachment_b64)
    reader = ipc.open_stream(buf)
    table = reader.read_all()
    return table.to_pylist()


class SQLWarehouseConnector:
    """Execute SQL statements against a Databricks SQL Warehouse."""

    def __init__(self, timeout: float = 60.0) -> None:
        self.timeout = timeout

    async def execute_statement(
        self,
        client: WorkspaceClient,
        *,
        statement: str,
        warehouse_id: str,
        parameters: list[dict[str, Any]] | None = None,
        disposition: str = "INLINE",
        format: str = "JSON_ARRAY",
        wait_timeout: str = "30s",
    ) -> StatementResponse:
        """Execute a SQL statement and poll until completion."""
        sdk_params = None
        if parameters:
            sdk_params = [
                StatementParameterListItem(
                    name=p["name"],
                    value=p.get("value"),
                    type=p.get("type"),
                )
                for p in parameters
            ]

        disp = Disposition(disposition)
        fmt = Format(format)

        response = await asyncio.to_thread(
            client.statement_execution.execute_statement,
            statement=statement,
            warehouse_id=warehouse_id,
            parameters=sdk_params,
            disposition=disp,
            format=fmt,
            wait_timeout=wait_timeout,
        )

        # Poll if still pending
        if response.status and response.status.state in _PENDING_STATES:
            response = await self._poll_until_done(client, response.statement_id)

        # Check for terminal failure states
        if response.status and response.status.state in _FAILED_STATES:
            error_msg = ""
            if response.status.error:
                error_msg = getattr(response.status.error, "message", str(response.status.error))
            raise RuntimeError(
                f"Statement {response.statement_id} failed with state "
                f"{response.status.state.value}: {error_msg}"
            )

        return response

    def transform_result(self, response: StatementResponse) -> list[dict[str, Any]]:
        """Transform a StatementResponse into row dicts.

        Handles three result shapes (matching TS _transformDataArray):
        1. Inline Arrow IPC attachment (serverless warehouses) → decode base64
        2. data_array (classic warehouses) → zip with column names
        3. external_links (large results) → not transformed here
        """
        result = response.result
        if result is None:
            return []

        # 1. Inline Arrow IPC attachment
        attachment = getattr(result, "attachment", None)
        if attachment:
            try:
                return decode_arrow_attachment(attachment)
            except Exception as exc:
                logger.warning("Failed to decode inline Arrow IPC attachment: %s", exc)
                # Fall through to data_array

        # 2. data_array (JSON format)
        if result.data_array:
            columns: list[str] = []
            if response.manifest and response.manifest.schema and response.manifest.schema.columns:
                columns = [c.name for c in response.manifest.schema.columns]
            rows: list[dict[str, Any]] = []
            for row in result.data_array:
                if columns:
                    rows.append(dict(zip(columns, row)))
                else:
                    rows.append({"values": row})
            return rows

        return []

    async def _poll_until_done(
        self, client: WorkspaceClient, statement_id: str
    ) -> StatementResponse:
        """Poll a statement until it reaches a terminal state."""
        delay = 1.0
        deadline = time.monotonic() + self.timeout

        while time.monotonic() < deadline:
            await asyncio.sleep(delay)
            response = await asyncio.to_thread(
                client.statement_execution.get_statement, statement_id
            )
            if response.status and response.status.state not in _PENDING_STATES:
                return response
            delay = min(delay * 1.5, 5.0)

        raise TimeoutError(f"Statement {statement_id} did not complete within {self.timeout}s")

    async def get_arrow_data(
        self, client: WorkspaceClient, job_id: str
    ) -> dict[str, Any]:
        """Fetch Arrow binary data for a completed statement.

        Downloads external link chunks and concatenates into a single buffer.
        """
        response = await asyncio.to_thread(
            client.statement_execution.get_statement, job_id
        )

        if not response.result:
            raise ValueError(f"No result available for job {job_id}")

        # Check for inline attachment first
        attachment = getattr(response.result, "attachment", None)
        if attachment:
            return {"data": base64.b64decode(attachment)}

        # Download from external links
        if response.result.external_links:
            chunks: list[bytes] = []
            async with httpx.AsyncClient(timeout=30.0) as http:
                for link in response.result.external_links:
                    url = getattr(link, "external_link", None) or getattr(link, "url", None)
                    if url:
                        resp = await http.get(url)
                        resp.raise_for_status()
                        chunks.append(resp.content)
            return {"data": b"".join(chunks)}

        raise ValueError(f"No Arrow data available for job {job_id}")
