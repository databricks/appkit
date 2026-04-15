"""Analytics plugin for SQL query execution.

Mirrors packages/appkit/src/plugins/analytics/analytics.ts
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from appkit_py.connectors.sql_warehouse.client import SQLWarehouseConnector
from appkit_py.context.execution_context import get_current_user_id
from appkit_py.plugin.plugin import Plugin, to_plugin
from appkit_py.plugins.analytics.query import QueryProcessor

logger = logging.getLogger("appkit.analytics")

# Default execution settings matching TS queryDefaults
_QUERY_DEFAULTS = {
    "cache_ttl": 3600,
    "retry_attempts": 3,
    "retry_initial_delay": 1.5,
    "timeout": 18.0,
}

# Format configs matching TS FORMAT_CONFIGS
_FORMAT_CONFIGS = {
    "ARROW_STREAM": {"disposition": "INLINE", "format": "ARROW_STREAM", "type": "result"},
    "JSON": {"disposition": "INLINE", "format": "JSON_ARRAY", "type": "result"},
    "ARROW": {"disposition": "EXTERNAL_LINKS", "format": "ARROW_STREAM", "type": "arrow"},
}

_FORMAT_ERROR_SIGNALS = [
    "ARROW_STREAM", "JSON_ARRAY", "EXTERNAL_LINKS",
    "INVALID_PARAMETER_VALUE", "NOT_IMPLEMENTED", "format field must be",
]


class AnalyticsPlugin(Plugin):
    name = "analytics"
    phase = "normal"

    default_cache_ttl = _QUERY_DEFAULTS["cache_ttl"]
    default_retry_attempts = _QUERY_DEFAULTS["retry_attempts"]
    default_retry_initial_delay = _QUERY_DEFAULTS["retry_initial_delay"]
    default_timeout = _QUERY_DEFAULTS["timeout"]

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self.sql_client = SQLWarehouseConnector(
            timeout=self.config.get("timeout", 60.0)
        )
        self.query_processor = QueryProcessor()
        self._query_dir = self.config.get("query_dir") or self._find_query_dir()
        self._warehouse_id = os.environ.get("DATABRICKS_WAREHOUSE_ID")

    def inject_routes(self, router: APIRouter) -> None:
        self.route(router, name="query", method="post", path="/query/{query_key}",
                   handler=self._handle_query)
        self.route(router, name="arrow", method="get", path="/arrow-result/{job_id}",
                   handler=self._handle_arrow)

    async def _handle_query(self, query_key: str, request: Request):
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass

        format_ = body.get("format", "ARROW_STREAM")
        parameters = body.get("parameters")

        if not query_key:
            return JSONResponse({"error": "query_key is required"}, status_code=400)

        query_text = self._load_query(query_key)
        if query_text is None:
            return JSONResponse({"error": "Query not found"}, status_code=404)

        is_obo = query_key.endswith(".obo") or self._has_obo_file(query_key)
        plugin = self.as_user(request) if is_obo else self

        async def handler(signal=None):
            client = self.get_workspace_client(request if is_obo else None)
            if not client or not self._warehouse_id:
                yield {"type": "error", "error": "Databricks connection not configured"}
                return

            converted = self.query_processor.convert_to_sql_parameters(query_text, parameters)

            # Format fallback: ARROW_STREAM → JSON → ARROW (matching TS)
            fallback_order = ["ARROW_STREAM", "JSON", "ARROW"] if format_ == "ARROW_STREAM" else [format_]
            response = None
            result_type = "result"

            for i, fmt_name in enumerate(fallback_order):
                fmt_config = _FORMAT_CONFIGS.get(fmt_name, _FORMAT_CONFIGS["JSON"])
                try:
                    response = await self.sql_client.execute_statement(
                        client,
                        statement=converted["statement"],
                        warehouse_id=self._warehouse_id,
                        parameters=converted.get("parameters") or None,
                        disposition=fmt_config["disposition"],
                        format=fmt_config["format"],
                    )
                    result_type = fmt_config["type"]
                    if i > 0:
                        logger.info("Query succeeded with fallback format %s", fmt_name)
                    break
                except Exception as fmt_err:
                    msg = str(fmt_err)
                    is_format_error = any(s in msg for s in _FORMAT_ERROR_SIGNALS)
                    if not is_format_error or i == len(fallback_order) - 1:
                        raise
                    logger.warning("Format %s rejected, falling back: %s", fmt_name, msg)

            if response is None:
                raise RuntimeError("All format fallbacks exhausted")

            if result_type == "arrow" and response.statement_id:
                yield {"type": "arrow", "statement_id": response.statement_id}
            else:
                result_data = self.sql_client.transform_result(response)
                yield {
                    "type": "result",
                    "chunk_index": 0,
                    "row_offset": 0,
                    "row_count": len(result_data),
                    "data": result_data,
                }

        return await self.execute_stream(request, handler)

    async def _handle_arrow(self, job_id: str, request: Request):
        client = self.get_workspace_client()
        if not client:
            return JSONResponse(
                {"error": "Arrow job not found", "plugin": self.name}, status_code=404
            )
        try:
            result = await self.sql_client.get_arrow_data(client, job_id)
            return Response(
                content=result["data"],
                media_type="application/octet-stream",
                headers={
                    "Content-Length": str(len(result["data"])),
                    "Cache-Control": "public, max-age=3600",
                },
            )
        except Exception as exc:
            return JSONResponse(
                {"error": str(exc) or "Arrow job not found", "plugin": self.name},
                status_code=404,
            )

    async def query(
        self,
        query: str,
        parameters: dict[str, Any] | None = None,
        format_parameters: dict[str, Any] | None = None,
        signal: Any = None,
    ) -> Any:
        """Execute a SQL query programmatically (matching TS exports().query)."""
        client = self.get_workspace_client()
        if not client or not self._warehouse_id:
            raise RuntimeError("Databricks connection not configured")

        converted = self.query_processor.convert_to_sql_parameters(query, parameters)
        fp = format_parameters or {}
        response = await self.sql_client.execute_statement(
            client,
            statement=converted["statement"],
            warehouse_id=self._warehouse_id,
            parameters=converted.get("parameters") or None,
            disposition=fp.get("disposition", "INLINE"),
            format=fp.get("format", "JSON_ARRAY"),
        )
        return self.sql_client.transform_result(response)

    def exports(self) -> dict[str, Any]:
        return {"query": self.query}

    # -----------------------------------------------------------------------
    # Query file helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _find_query_dir() -> str | None:
        for candidate in ["config/queries", "../config/queries", "../../config/queries"]:
            if Path(candidate).is_dir():
                return candidate
        return None

    def _load_query(self, query_key: str) -> str | None:
        if not self._query_dir:
            return None
        if "/" in query_key or "\\" in query_key or ".." in query_key:
            return None
        base = query_key.removesuffix(".obo")
        dir_path = Path(self._query_dir).resolve()
        for suffix in [".obo.sql", ".sql"]:
            file_path = (dir_path / f"{base}{suffix}").resolve()
            if not str(file_path).startswith(str(dir_path) + os.sep):
                return None
            if file_path.is_file():
                return file_path.read_text()
        return None

    def _has_obo_file(self, query_key: str) -> bool:
        if not self._query_dir:
            return False
        base = query_key.removesuffix(".obo")
        return (Path(self._query_dir) / f"{base}.obo.sql").is_file()


analytics = to_plugin(AnalyticsPlugin)
