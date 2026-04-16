"""VectorSearchPlugin — query Databricks Vector Search indexes.

Exposes two routes mounted under ``/api/vector-search``:

- ``POST /query`` — run a query against a configured index alias.
- ``POST /query-next-page`` — fetch the next page of a paginated query.

The Rust ``VectorSearchConnector`` owns request-body construction (see
``packages/appkit-rs/src/connectors/vector_search.rs``). This module
handles request parsing, per-index defaults, and OBO token extraction.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any

from appkit import (
    Plugin,
    PluginManifest,
    ValidationError,
    VectorSearchConnector,
)

from ._obo import obo_token, obo_user_key

_VALID_QUERY_TYPES = ("ann", "hybrid", "full_text")


class VectorSearchIndexConfig:
    """Per-index alias configuration.

    ``index_name`` is the fully-qualified ``catalog.schema.index`` name.
    ``endpoint_name`` is required when paginating. ``columns`` lists
    the columns returned from the index; ``query_type`` picks the
    default search mode. ``reranker_columns`` enables the Databricks
    reranker when non-empty.
    """

    __slots__ = (
        "index_name",
        "endpoint_name",
        "columns",
        "query_type",
        "num_results",
        "reranker_columns",
    )

    def __init__(
        self,
        *,
        index_name: str,
        endpoint_name: str | None = None,
        columns: list[str] | None = None,
        query_type: str = "hybrid",
        num_results: int = 20,
        reranker_columns: list[str] | None = None,
    ) -> None:
        if not index_name:
            raise ValueError("VectorSearchIndexConfig.index_name is required")
        if query_type not in _VALID_QUERY_TYPES:
            raise ValueError(
                f"Invalid query_type {query_type!r}; expected one of "
                f"{_VALID_QUERY_TYPES}"
            )
        self.index_name = index_name
        self.endpoint_name = endpoint_name
        self.columns = list(columns or [])
        self.query_type = query_type
        self.num_results = num_results
        self.reranker_columns = list(reranker_columns) if reranker_columns else None

    def __repr__(self) -> str:
        return (
            f"VectorSearchIndexConfig(index_name={self.index_name!r}, "
            f"query_type={self.query_type!r})"
        )


class VectorSearchPluginConfig:
    """Configuration for :class:`VectorSearchPlugin`.

    ``indexes`` maps alias → :class:`VectorSearchIndexConfig`.
    """

    __slots__ = ("indexes", "host", "timeout_ms")

    def __init__(
        self,
        *,
        indexes: Mapping[str, VectorSearchIndexConfig],
        host: str | None = None,
        timeout_ms: int | None = None,
    ) -> None:
        if not indexes:
            raise ValueError(
                "VectorSearchPluginConfig requires at least one index"
            )
        self.indexes: dict[str, VectorSearchIndexConfig] = dict(indexes)
        self.host = host
        self.timeout_ms = timeout_ms

    def __repr__(self) -> str:
        return (
            f"VectorSearchPluginConfig(indexes={sorted(self.indexes)!r})"
        )


class VectorSearchPlugin(Plugin):
    """Vector Search plugin — hybrid, ANN, and full-text queries."""

    NAME = "vector-search"

    def __init__(self, config: VectorSearchPluginConfig) -> None:
        super().__init__(
            self.NAME,
            manifest=PluginManifest(
                self.NAME,
                display_name="Vector Search Plugin",
                description=(
                    "Query Databricks Vector Search indexes with hybrid search, "
                    "reranking, and pagination"
                ),
            ),
        )
        host = config.host or os.environ.get("DATABRICKS_HOST")
        if not host:
            raise ValueError(
                "VectorSearchPlugin requires a Databricks host. Set "
                "DATABRICKS_HOST or pass host= in VectorSearchPluginConfig."
            )
        self._config = config
        self._host = host
        self._connector = VectorSearchConnector(host, timeout_ms=config.timeout_ms)

    def client_config(self) -> dict[str, str]:
        return {"indexes": ",".join(sorted(self._config.indexes))}

    def inject_routes(self, router: Any) -> None:
        router.post("/query", self._handle_query)
        router.post("/query-next-page", self._handle_next_page)

    def _resolve_index(self, alias: str) -> VectorSearchIndexConfig:
        try:
            return self._config.indexes[alias]
        except KeyError as exc:
            raise ValidationError(
                f"Unknown index alias {alias!r}. Configured: "
                f"{sorted(self._config.indexes)!r}"
            ) from exc

    async def _handle_query(self, request: Any) -> str:
        token = obo_token(request.headers)
        body = request.json() if request.body else {}
        if not isinstance(body, dict):
            raise ValidationError("Request body must be a JSON object")
        alias = body.get("index")
        if not alias:
            raise ValidationError("Missing required field 'index'")
        index_cfg = self._resolve_index(alias)

        query_text = body.get("query_text")
        query_vector = body.get("query_vector")
        if query_text is None and query_vector is None:
            raise ValidationError(
                "Request must include 'query_text' or 'query_vector'"
            )
        columns = body.get("columns") or index_cfg.columns
        if not columns:
            raise ValidationError(
                "'columns' must be set either on the request or in the index "
                "configuration"
            )
        query_type = body.get("query_type") or index_cfg.query_type
        if query_type not in _VALID_QUERY_TYPES:
            raise ValidationError(
                f"Invalid query_type {query_type!r}; expected one of "
                f"{_VALID_QUERY_TYPES}"
            )
        num_results = int(body.get("num_results") or index_cfg.num_results)
        filters = body.get("filters")
        filters_json = json.dumps(filters) if filters else None
        reranker_columns = body.get("reranker_columns") or index_cfg.reranker_columns

        async def run() -> str:
            return await self._connector.query(
                token,
                index_cfg.index_name,
                columns=list(columns),
                num_results=num_results,
                query_type=query_type,
                query_text=query_text,
                query_vector=query_vector,
                filters_json=filters_json,
                reranker_columns=reranker_columns,
            )

        result = await self.execute(run, user_key=obo_user_key(request.headers))
        if not result.ok:
            raise RuntimeError(result.message or "Vector search failed")
        return result.data or "{}"

    async def _handle_next_page(self, request: Any) -> str:
        token = obo_token(request.headers)
        body = request.json() if request.body else {}
        if not isinstance(body, dict):
            raise ValidationError("Request body must be a JSON object")
        alias = body.get("index")
        page_token = body.get("page_token")
        if not alias or not page_token:
            raise ValidationError(
                "'index' and 'page_token' are required for query-next-page"
            )
        index_cfg = self._resolve_index(alias)
        endpoint_name = body.get("endpoint_name") or index_cfg.endpoint_name
        if not endpoint_name:
            raise ValidationError(
                "'endpoint_name' is required (set it on the request or in "
                "the index configuration)"
            )
        raw = await self._connector.query_next_page(
            token, index_cfg.index_name, endpoint_name, page_token
        )
        return raw


__all__ = [
    "VectorSearchPlugin",
    "VectorSearchPluginConfig",
    "VectorSearchIndexConfig",
]
