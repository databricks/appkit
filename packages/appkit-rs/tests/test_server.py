"""Integration tests for Server types."""

import pytest

import appkit


class TestServerConfig:
    def test_defaults(self):
        cfg = appkit.ServerConfig()
        assert cfg.host == "0.0.0.0"
        assert cfg.port == 8000
        assert cfg.auto_start is True
        assert cfg.static_path is None

    def test_custom_values(self):
        cfg = appkit.ServerConfig(
            host="127.0.0.1",
            port=9090,
            auto_start=False,
            static_path="/dist",
        )
        assert cfg.host == "127.0.0.1"
        assert cfg.port == 9090
        assert cfg.auto_start is False
        assert cfg.static_path == "/dist"

    def test_repr(self):
        cfg = appkit.ServerConfig()
        r = repr(cfg)
        assert "ServerConfig" in r
        assert "8000" in r

    def test_equality(self):
        a = appkit.ServerConfig(port=8000)
        b = appkit.ServerConfig(port=8000)
        c = appkit.ServerConfig(port=9090)
        assert a == b
        assert a != c

    def test_hashable(self):
        cfg = appkit.ServerConfig()
        s = {cfg}
        assert len(s) == 1

    def test_frozen(self):
        cfg = appkit.ServerConfig()
        with pytest.raises(AttributeError):
            cfg.port = 9999


class TestRouter:
    def test_type_exists(self):
        assert hasattr(appkit, "Router")


class TestRequest:
    def test_type_exists(self):
        assert hasattr(appkit, "Request")
