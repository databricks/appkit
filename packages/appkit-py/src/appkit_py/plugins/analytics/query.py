"""QueryProcessor for SQL parameter processing.

Mirrors packages/appkit/src/plugins/analytics/query.ts
"""

from __future__ import annotations

import hashlib
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
    ) -> dict[str, Any] | None:
        """Process and validate query parameters."""
        if not parameters:
            return None
        return parameters
