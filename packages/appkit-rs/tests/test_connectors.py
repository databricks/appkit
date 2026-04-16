"""Integration tests for connector types and construction.

These tests verify Python-side construction and type behavior.
Actual HTTP calls are not made (no live Databricks workspace).
"""

import os

import pytest

import appkit


class TestFilesConnector:
    def test_constructor(self):
        fc = appkit.FilesConnector("https://host.databricks.com")
        assert "FilesConnector" in repr(fc)

    def test_with_default_volume(self):
        fc = appkit.FilesConnector(
            "https://host.databricks.com",
            default_volume="/Volumes/cat/sch/vol",
        )
        resolved = fc.resolve_path("file.txt")
        assert resolved == "/Volumes/cat/sch/vol/file.txt"

    def test_resolve_absolute_path(self):
        fc = appkit.FilesConnector("https://host.databricks.com")
        resolved = fc.resolve_path("/Volumes/cat/sch/vol/file.txt")
        assert resolved == "/Volumes/cat/sch/vol/file.txt"

    def test_path_traversal_rejected(self):
        fc = appkit.FilesConnector("https://host.databricks.com")
        with pytest.raises(ValueError, match="traversal"):
            fc.resolve_path("/Volumes/cat/sch/vol/../../../etc/passwd")

    def test_non_volumes_absolute_rejected(self):
        fc = appkit.FilesConnector("https://host.databricks.com")
        with pytest.raises(ValueError, match="/Volumes/"):
            fc.resolve_path("/etc/passwd")

    def test_relative_without_default_volume(self):
        fc = appkit.FilesConnector("https://host.databricks.com")
        with pytest.raises(ValueError, match="default volume"):
            fc.resolve_path("file.txt")


class TestFileDirectoryEntry:
    def test_repr(self):
        # FileDirectoryEntry is created by the connector, not directly.
        # Verify type exists and is importable.
        assert hasattr(appkit, "FileDirectoryEntry")


class TestSqlWarehouseConnector:
    def test_constructor(self):
        sw = appkit.SqlWarehouseConnector("https://host.databricks.com")
        assert "SqlWarehouseConnector" in repr(sw)

    def test_with_timeout(self):
        sw = appkit.SqlWarehouseConnector(
            "https://host.databricks.com", timeout_ms=30000
        )
        assert "30000" in repr(sw)


class TestSqlColumn:
    def test_type_exists(self):
        assert hasattr(appkit, "SqlColumn")


class TestSqlStatementResult:
    def test_type_exists(self):
        assert hasattr(appkit, "SqlStatementResult")


class TestGenieConnector:
    def test_constructor(self):
        gc = appkit.GenieConnector("https://host.databricks.com")
        assert "GenieConnector" in repr(gc)

    def test_with_options(self):
        gc = appkit.GenieConnector(
            "https://host.databricks.com",
            timeout_ms=60000,
            max_messages=100,
        )
        r = repr(gc)
        assert "60000" in r
        assert "100" in r


class TestServingConnector:
    def test_constructor(self):
        sc = appkit.ServingConnector("https://host.databricks.com")
        assert "ServingConnector" in repr(sc)


class TestServingResponse:
    def test_type_exists(self):
        assert hasattr(appkit, "ServingResponse")


class TestLakebaseConnector:
    def test_constructor(self):
        lc = appkit.LakebaseConnector("https://host.databricks.com")
        assert "LakebaseConnector" in repr(lc)


class TestLakebasePgConfig:
    def test_explicit_values(self):
        cfg = appkit.LakebasePgConfig(
            host="db.example.com",
            database="mydb",
            port=5433,
            ssl_mode="prefer",
            app_name="myapp",
        )
        assert cfg.host == "db.example.com"
        assert cfg.database == "mydb"
        assert cfg.port == 5433
        assert cfg.ssl_mode == "prefer"
        assert cfg.app_name == "myapp"

    def test_from_env(self):
        os.environ["PGHOST"] = "env-host.example.com"
        os.environ["PGDATABASE"] = "envdb"
        try:
            cfg = appkit.LakebasePgConfig.from_env()
            assert cfg.host == "env-host.example.com"
            assert cfg.database == "envdb"
            assert cfg.port == 5432  # default
            assert cfg.ssl_mode == "require"  # default
        finally:
            os.environ.pop("PGHOST", None)
            os.environ.pop("PGDATABASE", None)

    def test_missing_host_raises(self):
        os.environ.pop("PGHOST", None)
        os.environ.pop("LAKEBASE_ENDPOINT", None)
        os.environ["PGDATABASE"] = "db"
        try:
            with pytest.raises(ValueError, match="host"):
                appkit.LakebasePgConfig.from_env()
        finally:
            os.environ.pop("PGDATABASE", None)

    def test_equality(self):
        a = appkit.LakebasePgConfig(host="h", database="d")
        b = appkit.LakebasePgConfig(host="h", database="d")
        assert a == b

    def test_hashable(self):
        cfg = appkit.LakebasePgConfig(host="h", database="d")
        s = {cfg}
        assert len(s) == 1


class TestDatabaseCredential:
    def test_type_exists(self):
        assert hasattr(appkit, "DatabaseCredential")
