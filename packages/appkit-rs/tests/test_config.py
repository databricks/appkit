"""Integration tests for AppConfig."""

import os

import pytest

import appkit


class TestAppConfig:
    def test_constructor_defaults(self):
        cfg = appkit.AppConfig("https://host.databricks.com")
        assert cfg.databricks_host == "https://host.databricks.com"
        assert cfg.client_id is None
        assert cfg.client_secret is None
        assert cfg.warehouse_id is None
        assert cfg.app_port == 8000
        assert cfg.host == "0.0.0.0"
        assert cfg.otel_endpoint is None

    def test_constructor_keyword_only(self):
        cfg = appkit.AppConfig(
            "https://host.databricks.com",
            client_id="cid",
            client_secret="secret",
            warehouse_id="wh-1",
            app_port=9090,
            host="127.0.0.1",
            otel_endpoint="http://otel:4317",
        )
        assert cfg.client_id == "cid"
        assert cfg.client_secret == "secret"
        assert cfg.warehouse_id == "wh-1"
        assert cfg.app_port == 9090
        assert cfg.host == "127.0.0.1"
        assert cfg.otel_endpoint == "http://otel:4317"

    def test_from_env(self):
        os.environ["DATABRICKS_HOST"] = "https://env.databricks.com"
        os.environ["DATABRICKS_CLIENT_ID"] = "env-cid"
        os.environ["DATABRICKS_APP_PORT"] = "7070"
        try:
            cfg = appkit.AppConfig.from_env()
            assert cfg.databricks_host == "https://env.databricks.com"
            assert cfg.client_id == "env-cid"
            assert cfg.app_port == 7070
        finally:
            os.environ.pop("DATABRICKS_HOST", None)
            os.environ.pop("DATABRICKS_CLIENT_ID", None)
            os.environ.pop("DATABRICKS_APP_PORT", None)

    def test_from_env_missing_host(self):
        os.environ.pop("DATABRICKS_HOST", None)
        with pytest.raises(ValueError, match="DATABRICKS_HOST"):
            appkit.AppConfig.from_env()

    def test_repr(self):
        cfg = appkit.AppConfig("https://host.databricks.com", app_port=8080)
        r = repr(cfg)
        assert "AppConfig" in r
        assert "host.databricks.com" in r

    def test_equality(self):
        a = appkit.AppConfig("https://host.databricks.com", client_id="cid")
        b = appkit.AppConfig("https://host.databricks.com", client_id="cid")
        c = appkit.AppConfig("https://other.databricks.com")
        assert a == b
        assert a != c

    def test_hashable(self):
        cfg = appkit.AppConfig("https://host.databricks.com")
        s = {cfg}  # should be hashable
        assert len(s) == 1

    def test_frozen(self):
        cfg = appkit.AppConfig("https://host.databricks.com")
        with pytest.raises(AttributeError):
            cfg.databricks_host = "changed"
