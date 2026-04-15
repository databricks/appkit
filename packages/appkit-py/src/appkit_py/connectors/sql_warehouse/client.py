"""SQL Warehouse connector wrapping databricks.sdk.

Mirrors packages/appkit/src/connectors/sql-warehouse/client.ts
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

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

        # Execute in a thread to avoid blocking the event loop
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

        return response

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
        """Fetch Arrow binary data for a completed statement."""
        response = await asyncio.to_thread(
            client.statement_execution.get_statement, job_id
        )
        if response.result and response.result.external_links:
            # Download from external links
            # For now return the first chunk
            link = response.result.external_links[0]
            # The actual download would use the link URL
            raise NotImplementedError("External Arrow link download not yet implemented")

        raise ValueError(f"No Arrow data available for job {job_id}")
