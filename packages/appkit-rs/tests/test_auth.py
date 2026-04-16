"""Integration tests for ServiceContext and UserContext."""

import pytest

import appkit


class TestUserContext:
    def test_constructor(self, user_context):
        assert user_context.token == "test-token"
        assert user_context.user_id == "user-42"
        assert user_context.user_name == "Alice"
        assert user_context.workspace_id == "ws-123"
        assert user_context.warehouse_id == "wh-456"

    def test_is_user_context_property(self, user_context):
        assert user_context.is_user_context is True

    def test_keyword_only_workspace_id(self):
        ctx = appkit.UserContext(
            "tok",
            "uid",
            workspace_id="ws",
        )
        assert ctx.workspace_id == "ws"
        assert ctx.warehouse_id is None
        assert ctx.user_name is None

    def test_repr(self, user_context):
        r = repr(user_context)
        assert "UserContext" in r
        assert "user-42" in r

    def test_equality(self):
        a = appkit.UserContext("tok", "u1", workspace_id="ws")
        b = appkit.UserContext("tok", "u1", workspace_id="ws")
        c = appkit.UserContext("tok2", "u1", workspace_id="ws")
        assert a == b
        assert a != c

    def test_hashable(self):
        ctx = appkit.UserContext("tok", "u1", workspace_id="ws")
        s = {ctx}
        assert len(s) == 1

    def test_frozen(self, user_context):
        with pytest.raises(AttributeError):
            user_context.token = "new"


class TestServiceContext:
    def test_constructor(self, app_config):
        svc = appkit.ServiceContext(app_config)
        assert svc.config == app_config

    def test_missing_client_id(self):
        cfg = appkit.AppConfig("https://host.databricks.com")
        with pytest.raises(ValueError, match="CLIENT_ID"):
            appkit.ServiceContext(cfg)

    def test_missing_client_secret(self):
        cfg = appkit.AppConfig(
            "https://host.databricks.com", client_id="cid"
        )
        with pytest.raises(ValueError, match="CLIENT_SECRET"):
            appkit.ServiceContext(cfg)

    def test_repr(self, app_config):
        svc = appkit.ServiceContext(app_config)
        r = repr(svc)
        assert "ServiceContext" in r
        assert "test.databricks.com" in r
