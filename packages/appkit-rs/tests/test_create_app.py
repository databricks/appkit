"""Integration tests for the top-level create_app() orchestrator."""

import pytest

import appkit


class TestCreateApp:
    @pytest.mark.asyncio
    async def test_create_app_with_plugin(self, app_config):
        """Full lifecycle through create_app: register, init, plugin ready."""

        class TestPlugin(appkit.Plugin):
            def __init__(self):
                super().__init__(
                    "test-plugin",
                    manifest=appkit.PluginManifest("test-plugin"),
                )
                self.setup_called = False

            async def setup(self):
                self.setup_called = True

        plugin = TestPlugin()
        app = await appkit.create_app(
            config=app_config,
            plugins=[plugin],
            auto_start=False,
        )
        assert isinstance(app, appkit.AppKit)
        assert bool(app) is True
        assert plugin.is_ready is True
        assert plugin.setup_called is True

    @pytest.mark.asyncio
    async def test_create_app_no_plugins(self, app_config):
        app = await appkit.create_app(
            config=app_config,
            auto_start=False,
        )
        assert isinstance(app, appkit.AppKit)
        assert len(app) == 0

    @pytest.mark.asyncio
    async def test_create_app_with_cache_config(self, app_config, cache_config):
        app = await appkit.create_app(
            config=app_config,
            cache_config=cache_config,
            auto_start=False,
        )
        assert isinstance(app, appkit.AppKit)

    @pytest.mark.asyncio
    async def test_create_app_with_server_config(self, app_config):
        server_cfg = appkit.ServerConfig(
            port=9999,
            auto_start=False,
        )
        app = await appkit.create_app(
            config=app_config,
            server_config=server_cfg,
            auto_start=False,
        )
        assert isinstance(app, appkit.AppKit)

    @pytest.mark.asyncio
    async def test_create_app_multiple_plugins_phase_order(self, app_config):
        """Verify create_app respects phase ordering for multiple plugins."""
        order = []

        class OrderPlugin(appkit.Plugin):
            def __init__(self, name, phase):
                super().__init__(
                    name,
                    phase=phase,
                    manifest=appkit.PluginManifest(name),
                )

            async def setup(self):
                order.append(self.name)

        plugins = [
            OrderPlugin("deferred-p", "deferred"),
            OrderPlugin("core-p", "core"),
            OrderPlugin("normal-p", "normal"),
        ]

        await appkit.create_app(
            config=app_config,
            plugins=plugins,
            auto_start=False,
        )

        assert order.index("core-p") < order.index("normal-p")
        assert order.index("normal-p") < order.index("deferred-p")

    @pytest.mark.asyncio
    async def test_create_app_execute_through_plugin(self, app_config):
        """End-to-end: create_app → execute function through interceptor chain."""

        class ApiPlugin(appkit.Plugin):
            def __init__(self):
                super().__init__(
                    "api",
                    manifest=appkit.PluginManifest("api"),
                )

        plugin = ApiPlugin()
        app = await appkit.create_app(
            config=app_config,
            plugins=[plugin],
            auto_start=False,
        )

        async def compute():
            return '{"status": "ok", "count": 7}'

        result = await plugin.execute(compute, user_key="test-user")
        assert result.ok is True
        assert "count" in result.data
        assert "7" in result.data

    @pytest.mark.asyncio
    async def test_keyword_only_signature(self, app_config):
        """Verify create_app requires keyword arguments."""
        # This should work
        await appkit.create_app(config=app_config, auto_start=False)

        # Positional args should fail
        with pytest.raises(TypeError):
            await appkit.create_app(app_config, [], None, None, False)
