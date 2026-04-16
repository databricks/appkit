"""AnalyticsPlugin — SQL query execution against a Databricks SQL Warehouse.

Loads parameterised SQL files from ``config/queries/`` and exposes a
``POST /api/analytics/query/:query_key`` route. Query files ending in
``.obo.sql`` execute as the calling user (OBO); plain ``.sql`` executes
as the configured service principal.

The Rust side owns query-file discovery, ``:param`` extraction (literal-
and comment-aware), and cache-key composition — see
``packages/appkit-rs/src/plugins/analytics.rs``. This module provides
the Python plugin surface: route injection, request parsing, OBO
handling, and parameter validation against the query placeholders.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from appkit import (
    Plugin,
    PluginManifest,
    SqlWarehouseConnector,
    ValidationError,
)

from ._obo import obo_token, obo_user_key

# Mirror the Rust `is_valid_query_key` rule — no path traversal.
_QUERY_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class AnalyticsPluginConfig:
    """Configuration for :class:`AnalyticsPlugin`.

    ``warehouse_id`` routes queries to a Databricks SQL warehouse.
    ``queries_dir`` overrides the default ``config/queries`` path.
    ``host`` defaults to the ``DATABRICKS_HOST`` environment variable.
    """

    __slots__ = ("warehouse_id", "queries_dir", "host", "timeout_ms")

    def __init__(
        self,
        *,
        warehouse_id: str | None = None,
        queries_dir: str | os.PathLike[str] | None = None,
        host: str | None = None,
        timeout_ms: int | None = None,
    ) -> None:
        self.warehouse_id = warehouse_id
        self.queries_dir = Path(queries_dir) if queries_dir else None
        self.host = host
        self.timeout_ms = timeout_ms

    def __repr__(self) -> str:
        return (
            f"AnalyticsPluginConfig(warehouse_id={self.warehouse_id!r}, "
            f"queries_dir={self.queries_dir!r})"
        )


def _extract_param_names(query: str) -> list[str]:
    """Extract `:param_name` placeholders, skipping SQL string/comment contexts.

    Mirrors ``QueryProcessor::extract_param_names`` in
    ``packages/appkit-rs/src/plugins/analytics.rs`` — see that module for
    the canonical specification. This Python port exists so the plugin
    can validate extra-key errors locally without a Rust round-trip.
    """
    out: list[str] = []
    seen: set[str] = set()
    i = 0
    n = len(query)
    while i < n:
        c = query[i]

        # Line comment: -- ... to end of line.
        if c == "-" and i + 1 < n and query[i + 1] == "-":
            i += 2
            while i < n and query[i] != "\n":
                i += 1
            continue

        # Block comment: /* ... */, nestable.
        if c == "/" and i + 1 < n and query[i + 1] == "*":
            i += 2
            depth = 1
            while i < n and depth > 0:
                if i + 1 < n and query[i] == "/" and query[i + 1] == "*":
                    depth += 1
                    i += 2
                elif i + 1 < n and query[i] == "*" and query[i + 1] == "/":
                    depth -= 1
                    i += 2
                else:
                    i += 1
            continue

        # Single-quoted string literal: '...'. Doubled '' is an escape.
        if c == "'":
            i += 1
            while i < n:
                if query[i] == "'":
                    if i + 1 < n and query[i + 1] == "'":
                        i += 2
                    else:
                        i += 1
                        break
                else:
                    i += 1
            continue

        # Double-quoted identifier: "...". Doubled "" is an escape.
        if c == '"':
            i += 1
            while i < n:
                if query[i] == '"':
                    if i + 1 < n and query[i + 1] == '"':
                        i += 2
                    else:
                        i += 1
                        break
                else:
                    i += 1
            continue

        # Dollar-quoted string: $tag$...$tag$ (tag may be empty).
        if c == "$":
            tag_end = i + 1
            while tag_end < n and _is_ident_continue(query[tag_end]):
                tag_end += 1
            if tag_end < n and query[tag_end] == "$":
                delim = query[i : tag_end + 1]
                j = tag_end + 1
                hit = query.find(delim, j)
                i = hit + len(delim) if hit != -1 else n
                continue

        if c == ":":
            # `::TYPE` cast — consume both colons plus the type identifier.
            if i + 1 < n and query[i + 1] == ":":
                i += 2
                while i < n and _is_ident_continue(query[i]):
                    i += 1
                continue
            if i + 1 < n and _is_ident_start(query[i + 1]):
                start = i + 1
                end = start
                while end < n and _is_ident_continue(query[end]):
                    end += 1
                name = query[start:end]
                if name and name not in seen:
                    seen.add(name)
                    out.append(name)
                i = end
                continue
        i += 1
    return out


def _is_ident_start(c: str) -> bool:
    return c.isalpha() or c == "_"


def _is_ident_continue(c: str) -> bool:
    return c.isalnum() or c == "_"


class _LoadedQuery:
    __slots__ = ("query_key", "query", "is_as_user")

    def __init__(self, query_key: str, query: str, *, is_as_user: bool) -> None:
        self.query_key = query_key
        self.query = query
        self.is_as_user = is_as_user


def _load_query(queries_dir: Path, query_key: str) -> _LoadedQuery | None:
    """Load `<query_key>.obo.sql` (preferred) or `<query_key>.sql`."""
    if not _QUERY_KEY_RE.match(query_key):
        return None
    obo = queries_dir / f"{query_key}.obo.sql"
    sp = queries_dir / f"{query_key}.sql"
    if obo.is_file():
        return _LoadedQuery(query_key, obo.read_text(), is_as_user=True)
    if sp.is_file():
        return _LoadedQuery(query_key, sp.read_text(), is_as_user=False)
    return None


class AnalyticsPlugin(Plugin):
    """SQL query execution plugin.

    Queries live on disk under ``queries_dir`` (default ``config/queries``)
    and are referenced by key in the route path.
    """

    NAME = "analytics"

    def __init__(self, config: AnalyticsPluginConfig) -> None:
        super().__init__(
            self.NAME,
            manifest=PluginManifest(
                self.NAME,
                display_name="Analytics Plugin",
                description="SQL query execution against Databricks SQL Warehouses",
            ),
        )
        host = config.host or os.environ.get("DATABRICKS_HOST")
        if not host:
            raise ValueError(
                "AnalyticsPlugin requires a Databricks host. Set DATABRICKS_HOST "
                "or pass host= in AnalyticsPluginConfig."
            )
        warehouse_id = config.warehouse_id or os.environ.get(
            "DATABRICKS_WAREHOUSE_ID"
        )
        if not warehouse_id:
            raise ValueError(
                "AnalyticsPlugin requires a warehouse_id. Set "
                "DATABRICKS_WAREHOUSE_ID or pass warehouse_id= in "
                "AnalyticsPluginConfig."
            )
        self._config = config
        self._host = host
        self._warehouse_id = warehouse_id
        self._queries_dir = config.queries_dir or Path("config") / "queries"
        self._connector = SqlWarehouseConnector(host, timeout_ms=config.timeout_ms)

    @property
    def queries_dir(self) -> Path:
        return self._queries_dir

    @property
    def warehouse_id(self) -> str:
        return self._warehouse_id

    def client_config(self) -> dict[str, str]:
        return {"warehouse_id": self._warehouse_id}

    def inject_routes(self, router: Any) -> None:
        router.post("/query/:query_key", self._handle_query)
        router.get("/queries", self._handle_list_queries)

    async def _handle_list_queries(self, _request: Any) -> str:
        if not self._queries_dir.is_dir():
            return json.dumps({"queries": []})
        keys: set[str] = set()
        for path in self._queries_dir.iterdir():
            if path.is_file() and path.suffix == ".sql":
                name = path.name
                if name.endswith(".obo.sql"):
                    keys.add(name[: -len(".obo.sql")])
                else:
                    keys.add(name[: -len(".sql")])
        return json.dumps({"queries": sorted(keys)})

    async def _handle_query(self, request: Any) -> str:
        query_key = self._extract_query_key(request.path)
        loaded = _load_query(self._queries_dir, query_key)
        if loaded is None:
            raise ValidationError(f"Unknown query: {query_key!r}")

        body = request.json() if request.body else {}
        if not isinstance(body, dict):
            raise ValidationError("Request body must be a JSON object")
        raw_params = body.get("parameters", {}) or {}
        if not isinstance(raw_params, dict):
            raise ValidationError("'parameters' must be a JSON object")

        param_names = _extract_param_names(loaded.query)
        param_set = set(param_names)
        for key in raw_params:
            if key not in param_set:
                valid = ", ".join(sorted(param_set)) if param_set else "none"
                raise ValidationError(
                    f"Invalid value for {key!r}: expected a parameter defined "
                    f"in the query (valid: {valid})"
                )

        sql_parameters: list[tuple[str, str]] = []
        for name, value in raw_params.items():
            if value is None:
                continue
            sql_parameters.append((name, _coerce_sql_value(value)))

        token, user_key = self._resolve_auth(request, loaded.is_as_user)

        async def run() -> str:
            result = await self._connector.execute_statement(
                token,
                loaded.query,
                self._warehouse_id,
                parameters=sql_parameters or None,
                timeout_ms=self._config.timeout_ms,
            )
            return json.dumps(
                {
                    "statement_id": result.statement_id,
                    "status": result.status,
                    "columns": [
                        {"name": c.name, "type": c.type_name} for c in result.columns
                    ],
                    "row_count": result.row_count,
                    "data": json.loads(result.data) if result.data else [],
                }
            )

        execution = await self.execute(
            run,
            user_key=user_key,
            cache_key=["analytics:query", query_key, json.dumps(raw_params, sort_keys=True)],
        )
        if not execution.ok:
            raise _status_to_error(execution.status or 500, execution.message or "")
        return execution.data or "{}"

    def _extract_query_key(self, path: str) -> str:
        tail = path.rsplit("/", 1)[-1]
        if not _QUERY_KEY_RE.match(tail):
            raise ValidationError(f"Invalid query key: {tail!r}")
        return tail

    def _resolve_auth(self, request: Any, is_as_user: bool) -> tuple[str, str]:
        if is_as_user:
            token = obo_token(request.headers)
            return token, obo_user_key(request.headers)
        env_token = os.environ.get("DATABRICKS_TOKEN", "")
        return env_token, ""


def _coerce_sql_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return ""
    return str(value)


def _status_to_error(status: int, message: str) -> Exception:
    from appkit import (
        AppKitError,
        AuthenticationError,
        InternalError,
        NotFoundError,
        TimeoutError as AppkitTimeoutError,
        UpstreamError,
    )

    if status == 400:
        return ValidationError(message)
    if status == 401:
        return AuthenticationError(message)
    if status == 404:
        return NotFoundError(message)
    if status == 408:
        return AppkitTimeoutError(message)
    if 500 <= status < 600 and status != 500:
        return UpstreamError(message)
    if status == 500:
        return InternalError(message)
    return AppKitError(message)


__all__ = ["AnalyticsPlugin", "AnalyticsPluginConfig"]
