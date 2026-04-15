"""QueryProcessor for SQL parameter processing.

Mirrors packages/appkit/src/plugins/analytics/query.ts
"""

from __future__ import annotations

import hashlib
import os
import re
from typing import Any


class QueryProcessor:
    """Process SQL queries: hash, convert named parameters, etc."""

    def hash_query(self, query: str) -> str:
        """SHA256 hash of the query text for cache keying."""
        return hashlib.sha256(query.encode()).hexdigest()

    def convert_to_sql_parameters(
        self,
        query: str,
        parameters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Convert named :param placeholders to Databricks SQL parameter format.

        Returns dict with 'statement' and 'parameters' keys.
        """
        if not parameters:
            return {"statement": query, "parameters": []}

        sql_params = []
        for name, value in parameters.items():
            if value is None:
                sql_params.append({"name": name, "value": None, "type": "STRING"})
            elif isinstance(value, dict) and "__sql_type" in value:
                sql_params.append({
                    "name": name,
                    "value": str(value["value"]),
                    "type": value["__sql_type"],
                })
            else:
                sql_params.append({"name": name, "value": str(value), "type": "STRING"})

        return {"statement": query, "parameters": sql_params}

    async def process_query_params(
        self,
        query: str,
        parameters: dict[str, Any] | None = None,
        *,
        workspace_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Process and validate query parameters.

        Auto-injects workspaceId if the query references :workspaceId and
        it's not already in the parameters.
        """
        params = dict(parameters) if parameters else {}

        # Auto-inject workspaceId if referenced in query but not provided
        if ":workspaceId" in query and "workspaceId" not in params:
            ws_id = workspace_id or os.environ.get("DATABRICKS_WORKSPACE_ID", "")
            if ws_id:
                params["workspaceId"] = {"__sql_type": "STRING", "value": ws_id}

        return params if params else None
