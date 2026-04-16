"""Integration tests for shipped Python plugin wrappers.

Covers construction, client_config, route registration, and OBO auth
extraction. Tests use a lightweight ``_MockRouter`` that records
``inject_routes`` calls so we can assert on method/path/stream flags
without booting the Rust HTTP server.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

import appkit
from appkit.plugins import (
    AnalyticsPlugin,
    AnalyticsPluginConfig,
    FilesPlugin,
    FilesPluginConfig,
    GeniePlugin,
    GeniePluginConfig,
    LakebasePlugin,
    LakebasePluginConfig,
    ServerPlugin,
    ServerPluginConfig,
    ServingEndpointConfig,
    ServingPlugin,
    ServingPluginConfig,
    VectorSearchIndexConfig,
    VectorSearchPlugin,
    VectorSearchPluginConfig,
    VolumeConfig,
    analytics,
    files,
    genie,
    lakebase,
    server,
    serving,
    vector_search,
)
from appkit.plugins.analytics import _extract_param_names


HOST = "https://test.databricks.com"


class _MockRouter:
    """Minimal router replacement that records route registrations."""

    def __init__(self) -> None:
        self.routes: list[tuple[str, str, bool]] = []

    def _add(self, method: str, path: str, _handler: Any, stream: bool) -> None:
        self.routes.append((method, path, stream))

    def get(self, path, handler, *, stream=False):
        self._add("GET", path, handler, stream)

    def post(self, path, handler, *, stream=False):
        self._add("POST", path, handler, stream)

    def put(self, path, handler, *, stream=False):
        self._add("PUT", path, handler, stream)

    def delete(self, path, handler, *, stream=False):
        self._add("DELETE", path, handler, stream)

    def patch(self, path, handler, *, stream=False):
        self._add("PATCH", path, handler, stream)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Ensure tests do not leak DATABRICKS_HOST across cases."""
    monkeypatch.setenv("DATABRICKS_HOST", HOST)
    yield


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------


class TestAnalyticsPlugin:
    def test_requires_warehouse(self, monkeypatch):
        monkeypatch.delenv("DATABRICKS_WAREHOUSE_ID", raising=False)
        with pytest.raises(ValueError, match="warehouse_id"):
            AnalyticsPlugin(AnalyticsPluginConfig())

    def test_construction(self):
        plugin = AnalyticsPlugin(
            AnalyticsPluginConfig(warehouse_id="wh-1", queries_dir="/tmp/q")
        )
        assert plugin.name == "analytics"
        assert plugin.warehouse_id == "wh-1"
        assert plugin.client_config() == {"warehouse_id": "wh-1"}

    def test_routes_registered(self):
        plugin = AnalyticsPlugin(AnalyticsPluginConfig(warehouse_id="wh-1"))
        router = _MockRouter()
        plugin.inject_routes(router)
        assert ("POST", "/query/:query_key", False) in router.routes
        assert ("GET", "/queries", False) in router.routes

    def test_entry_point(self):
        assert isinstance(
            analytics(AnalyticsPluginConfig(warehouse_id="wh-1")),
            AnalyticsPlugin,
        )


class TestParamExtraction:
    def test_basic(self):
        assert _extract_param_names("SELECT :foo, :bar") == ["foo", "bar"]

    def test_skips_single_quoted(self):
        assert _extract_param_names("SELECT ':not_a_param'") == []

    def test_skips_line_comment(self):
        assert _extract_param_names("-- :debug\nSELECT :real") == ["real"]

    def test_skips_block_comment(self):
        assert _extract_param_names("/* :debug */ SELECT :real") == ["real"]

    def test_skips_nested_block_comment(self):
        q = "/* outer /* :inner */ still_out */ SELECT :real"
        assert _extract_param_names(q) == ["real"]

    def test_cast_ignored(self):
        assert _extract_param_names("SELECT 1::INT") == []

    def test_double_quoted_identifier(self):
        assert _extract_param_names('SELECT ":not_a_param" FROM t') == []

    def test_dedup(self):
        assert _extract_param_names("SELECT :x, :x, :y") == ["x", "y"]


# ---------------------------------------------------------------------------
# Vector Search
# ---------------------------------------------------------------------------


class TestVectorSearchPlugin:
    def _cfg(self):
        return VectorSearchPluginConfig(
            indexes={
                "docs": VectorSearchIndexConfig(
                    index_name="catalog.schema.docs_idx",
                    columns=["id", "content"],
                ),
            }
        )

    def test_construction(self):
        plugin = VectorSearchPlugin(self._cfg())
        assert plugin.name == "vector-search"
        assert plugin.client_config() == {"indexes": "docs"}

    def test_routes(self):
        plugin = VectorSearchPlugin(self._cfg())
        router = _MockRouter()
        plugin.inject_routes(router)
        assert ("POST", "/query", False) in router.routes
        assert ("POST", "/query-next-page", False) in router.routes

    def test_invalid_query_type_rejected(self):
        with pytest.raises(ValueError, match="query_type"):
            VectorSearchIndexConfig(index_name="a.b.c", query_type="bogus")

    def test_entry_point(self):
        assert isinstance(vector_search(self._cfg()), VectorSearchPlugin)


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


class TestServerPlugin:
    def test_defaults(self):
        plugin = ServerPlugin()
        assert plugin.name == "server"
        assert plugin.phase == appkit.PluginPhase.CORE
        cfg = plugin.to_server_config()
        assert cfg.host == "0.0.0.0"
        assert cfg.port == 8000
        assert cfg.auto_start is True

    def test_custom_config(self):
        plugin = ServerPlugin(
            ServerPluginConfig(host="127.0.0.1", port=9090, auto_start=False)
        )
        cfg = plugin.to_server_config()
        assert cfg.host == "127.0.0.1"
        assert cfg.port == 9090
        assert cfg.auto_start is False

    def test_inject_routes_noop(self):
        plugin = ServerPlugin()
        router = _MockRouter()
        plugin.inject_routes(router)
        assert router.routes == []

    def test_entry_point(self):
        assert isinstance(server(), ServerPlugin)


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


class TestFilesPlugin:
    def _cfg(self):
        return FilesPluginConfig(
            volumes={"uploads": VolumeConfig(path="/Volumes/c/s/uploads")}
        )

    def test_construction(self):
        plugin = FilesPlugin(self._cfg())
        assert plugin.name == "files"
        assert plugin.client_config() == {"volumes": "uploads"}

    def test_routes(self):
        plugin = FilesPlugin(self._cfg())
        router = _MockRouter()
        plugin.inject_routes(router)
        methods = {(m, p) for m, p, _ in router.routes}
        assert ("GET", "/list") in methods
        assert ("POST", "/mkdir") in methods
        assert ("DELETE", "/delete") in methods

    def test_entry_point(self):
        assert isinstance(files(self._cfg()), FilesPlugin)


# ---------------------------------------------------------------------------
# Genie
# ---------------------------------------------------------------------------


class TestGeniePlugin:
    def _cfg(self):
        return GeniePluginConfig(spaces={"sales": "space-123"})

    def test_construction(self):
        plugin = GeniePlugin(self._cfg())
        assert plugin.name == "genie"
        assert plugin.client_config() == {"spaces": "sales"}

    def test_routes(self):
        plugin = GeniePlugin(self._cfg())
        router = _MockRouter()
        plugin.inject_routes(router)
        methods = {(m, p) for m, p, _ in router.routes}
        assert ("POST", "/message") in methods
        assert ("GET", "/conversation") in methods
        assert ("GET", "/query-result") in methods

    def test_entry_point(self):
        assert isinstance(genie(self._cfg()), GeniePlugin)


# ---------------------------------------------------------------------------
# Serving
# ---------------------------------------------------------------------------


class TestServingPlugin:
    def _cfg(self):
        return ServingPluginConfig(
            endpoints={
                "chat": ServingEndpointConfig(env="CHAT_ENDPOINT"),
            }
        )

    def test_requires_endpoint(self):
        with pytest.raises(ValueError, match="at least one endpoint"):
            ServingPluginConfig(endpoints={})

    def test_construction(self):
        plugin = ServingPlugin(self._cfg())
        assert plugin.name == "serving"
        assert plugin.client_config() == {"endpoints": "chat"}

    def test_routes(self):
        plugin = ServingPlugin(self._cfg())
        router = _MockRouter()
        plugin.inject_routes(router)
        assert ("POST", "/invoke/:endpoint", False) in router.routes
        assert ("POST", "/stream/:endpoint", True) in router.routes

    def test_resolve_endpoint_reads_env(self, monkeypatch):
        plugin = ServingPlugin(self._cfg())
        monkeypatch.setenv("CHAT_ENDPOINT", "databricks-dbrx")
        assert plugin.resolve_endpoint("chat") == "databricks-dbrx"

    def test_resolve_endpoint_missing_env(self, monkeypatch):
        plugin = ServingPlugin(self._cfg())
        monkeypatch.delenv("CHAT_ENDPOINT", raising=False)
        with pytest.raises(appkit.ValidationError, match="not set"):
            plugin.resolve_endpoint("chat")

    def test_resolve_endpoint_unknown_alias(self):
        plugin = ServingPlugin(self._cfg())
        with pytest.raises(appkit.ValidationError, match="Unknown endpoint"):
            plugin.resolve_endpoint("does-not-exist")

    def test_entry_point(self):
        assert isinstance(serving(self._cfg()), ServingPlugin)


# ---------------------------------------------------------------------------
# Lakebase
# ---------------------------------------------------------------------------


class TestLakebasePlugin:
    def _cfg(self):
        return LakebasePluginConfig(
            pg_config=appkit.LakebasePgConfig(host="db.example.com", database="mydb")
        )

    def test_construction(self):
        plugin = LakebasePlugin(self._cfg())
        assert plugin.name == "lakebase"
        assert plugin.pg_config.host == "db.example.com"
        assert plugin.pg_config.database == "mydb"

    def test_client_config(self):
        plugin = LakebasePlugin(self._cfg())
        cfg = plugin.client_config()
        assert cfg["database"] == "mydb"
        assert "ssl_mode" in cfg

    def test_exports(self):
        plugin = LakebasePlugin(self._cfg())
        exports = plugin.exports()
        assert exports["pg_host"] == "db.example.com"
        assert exports["pg_database"] == "mydb"
        assert exports["pg_port"] == "5432"

    def test_inject_routes_noop(self):
        plugin = LakebasePlugin(self._cfg())
        router = _MockRouter()
        plugin.inject_routes(router)
        assert router.routes == []

    def test_entry_point(self):
        # PGHOST/PGDATABASE required to default-construct LakebasePgConfig.
        os.environ["PGHOST"] = "h"
        os.environ["PGDATABASE"] = "d"
        try:
            assert isinstance(lakebase(), LakebasePlugin)
        finally:
            os.environ.pop("PGHOST", None)
            os.environ.pop("PGDATABASE", None)


# ---------------------------------------------------------------------------
# End-to-end: plugins subclass appkit.Plugin and register cleanly
# ---------------------------------------------------------------------------


class TestPluginRegistration:
    @pytest.mark.asyncio
    async def test_register_and_initialize(self, app_config):
        os.environ["CHAT_ENDPOINT"] = "dbrx-chat"
        try:
            plugins = [
                server(),
                analytics(AnalyticsPluginConfig(warehouse_id="wh-1")),
                vector_search(
                    VectorSearchPluginConfig(
                        indexes={
                            "docs": VectorSearchIndexConfig(
                                index_name="c.s.i", columns=["id"]
                            )
                        }
                    )
                ),
                serving(
                    ServingPluginConfig(
                        endpoints={
                            "chat": ServingEndpointConfig(env="CHAT_ENDPOINT")
                        }
                    )
                ),
            ]
            app = appkit.AppKit()
            for p in plugins:
                app.register(p)
            await app.initialize(app_config)
            assert set(app.plugin_names()) == {
                "server",
                "analytics",
                "vector-search",
                "serving",
            }
            for p in plugins:
                assert p.is_ready is True
        finally:
            os.environ.pop("CHAT_ENDPOINT", None)
