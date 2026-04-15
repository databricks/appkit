"""Unit tests for the Plugin base class."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit


class TestPluginBase:
    def test_import(self):
        from appkit_py.plugin.plugin import Plugin

    async def test_default_setup_is_noop(self):
        from appkit_py.plugin.plugin import Plugin

        class TestPlugin(Plugin):
            name = "test"

        plugin = TestPlugin(config={})
        await plugin.setup()  # Should not raise

    def test_default_exports_empty(self):
        from appkit_py.plugin.plugin import Plugin

        class TestPlugin(Plugin):
            name = "test"

        plugin = TestPlugin(config={})
        assert plugin.exports() == {}

    def test_default_client_config_empty(self):
        from appkit_py.plugin.plugin import Plugin

        class TestPlugin(Plugin):
            name = "test"

        plugin = TestPlugin(config={})
        assert plugin.client_config() == {}

    def test_default_inject_routes_is_noop(self):
        from appkit_py.plugin.plugin import Plugin

        class TestPlugin(Plugin):
            name = "test"

        plugin = TestPlugin(config={})
        # Should not raise with a mock router
        plugin.inject_routes(None)


class TestPluginAsUser:
    """Tests for the as_user() proxy pattern."""

    async def test_as_user_returns_proxy(self):
        from appkit_py.plugin.plugin import Plugin

        class TestPlugin(Plugin):
            name = "test"

            async def get_data(self):
                return "data"

        plugin = TestPlugin(config={})
        # Create a mock request with auth headers
        mock_request = type(
            "MockRequest",
            (),
            {
                "headers": {
                    "x-forwarded-user": "test-user",
                    "x-forwarded-access-token": "test-token",
                }
            },
        )()
        proxy = plugin.as_user(mock_request)
        assert proxy is not plugin  # Should be a different object
