"""Integration tests for Plugin, PluginManifest, ExecutionResult, and AppKit."""

import pytest

import appkit


class TestPluginPhase:
    def test_constants(self):
        assert appkit.PluginPhase.CORE == "core"
        assert appkit.PluginPhase.NORMAL == "normal"
        assert appkit.PluginPhase.DEFERRED == "deferred"


class TestPluginManifest:
    def test_constructor(self):
        m = appkit.PluginManifest("my-plugin")
        assert m.name == "my-plugin"
        assert m.display_name is None
        assert m.description is None

    def test_with_all_fields(self):
        m = appkit.PluginManifest(
            "my-plugin",
            display_name="My Plugin",
            description="A test plugin",
        )
        assert m.display_name == "My Plugin"
        assert m.description == "A test plugin"

    def test_repr(self):
        m = appkit.PluginManifest("my-plugin")
        assert "my-plugin" in repr(m)

    def test_equality(self):
        a = appkit.PluginManifest("p1")
        b = appkit.PluginManifest("p1")
        c = appkit.PluginManifest("p2")
        assert a == b
        assert a != c

    def test_hashable(self):
        m = appkit.PluginManifest("p1")
        s = {m}
        assert len(s) == 1


class TestExecutionResult:
    def test_ok_result(self):
        # ExecutionResult is only created by the framework, not directly.
        # Test via Plugin.execute() in the full lifecycle tests.
        pass

    def test_repr_format(self):
        # ExecutionResult instances come from execute(), tested in lifecycle.
        pass


class TestPlugin:
    def test_constructor(self):
        m = appkit.PluginManifest("test")
        p = appkit.Plugin("test", manifest=m)
        assert p.name == "test"
        assert p.phase == "normal"
        assert p.is_ready is False

    def test_phase_validation(self):
        m = appkit.PluginManifest("test")
        with pytest.raises(ValueError, match="Invalid phase"):
            appkit.Plugin("test", phase="invalid", manifest=m)

    def test_core_phase(self):
        m = appkit.PluginManifest("test")
        p = appkit.Plugin("test", phase="core", manifest=m)
        assert p.phase == "core"

    def test_repr(self):
        m = appkit.PluginManifest("test")
        p = appkit.Plugin("test", manifest=m)
        r = repr(p)
        assert "Plugin" in r
        assert "test" in r

    def test_subclassing(self):
        class MyPlugin(appkit.Plugin):
            def __init__(self):
                super().__init__(
                    "my-custom",
                    manifest=appkit.PluginManifest("my-custom"),
                )

        p = MyPlugin()
        assert p.name == "my-custom"
        assert isinstance(p, appkit.Plugin)

    def test_exports_default_empty(self):
        m = appkit.PluginManifest("test")
        p = appkit.Plugin("test", manifest=m)
        assert p.exports() == {}

    def test_client_config_default_empty(self):
        m = appkit.PluginManifest("test")
        p = appkit.Plugin("test", manifest=m)
        assert p.client_config() == {}

    def test_execute_before_init_raises(self):
        m = appkit.PluginManifest("test")
        p = appkit.Plugin("test", manifest=m)
        with pytest.raises(RuntimeError, match="not initialized"):
            import asyncio

            asyncio.get_event_loop().run_until_complete(
                p.execute(lambda: None)
            )


class TestAppKit:
    def test_constructor(self):
        app = appkit.AppKit()
        assert repr(app).startswith("AppKit")
        assert len(app) == 0
        assert bool(app) is False  # not initialized

    def test_register(self):
        app = appkit.AppKit()
        m = appkit.PluginManifest("p1")
        p = appkit.Plugin("p1", manifest=m)
        app.register(p)
        assert len(app) == 1
        assert "p1" in app

    def test_contains(self):
        app = appkit.AppKit()
        m = appkit.PluginManifest("p1")
        p = appkit.Plugin("p1", manifest=m)
        app.register(p)
        assert "p1" in app
        assert "nonexistent" not in app

    @pytest.mark.asyncio
    async def test_initialize(self, app_config):
        app = appkit.AppKit()
        m = appkit.PluginManifest("p1")
        p = appkit.Plugin("p1", manifest=m)
        app.register(p)

        await app.initialize(app_config)
        assert bool(app) is True  # initialized
        assert p.is_ready is True

    @pytest.mark.asyncio
    async def test_double_initialize_raises(self, app_config):
        app = appkit.AppKit()
        await app.initialize(app_config)
        with pytest.raises(RuntimeError, match="already initialized"):
            await app.initialize(app_config)

    @pytest.mark.asyncio
    async def test_register_after_init_raises(self, app_config):
        app = appkit.AppKit()
        await app.initialize(app_config)
        m = appkit.PluginManifest("late")
        p = appkit.Plugin("late", manifest=m)
        with pytest.raises(RuntimeError, match="Cannot register"):
            app.register(p)

    @pytest.mark.asyncio
    async def test_get_plugin(self, app_config):
        app = appkit.AppKit()
        m = appkit.PluginManifest("p1")
        p = appkit.Plugin("p1", manifest=m)
        app.register(p)
        await app.initialize(app_config)

        found = app.get_plugin("p1")
        assert found is not None
        assert found.name == "p1"

        assert app.get_plugin("nonexistent") is None

    @pytest.mark.asyncio
    async def test_plugin_names(self, app_config):
        app = appkit.AppKit()
        for name in ["alpha", "beta", "gamma"]:
            m = appkit.PluginManifest(name)
            p = appkit.Plugin(name, manifest=m)
            app.register(p)
        await app.initialize(app_config)

        names = app.plugin_names()
        assert set(names) == {"alpha", "beta", "gamma"}

    @pytest.mark.asyncio
    async def test_phase_ordering(self, app_config):
        """Verify plugins are initialized in phase order."""
        order = []

        class TrackingPlugin(appkit.Plugin):
            def __init__(self, name, phase):
                super().__init__(
                    name,
                    phase=phase,
                    manifest=appkit.PluginManifest(name),
                )

            async def setup(self):
                order.append(self.name)

        app = appkit.AppKit()
        app.register(TrackingPlugin("deferred-1", "deferred"))
        app.register(TrackingPlugin("core-1", "core"))
        app.register(TrackingPlugin("normal-1", "normal"))
        app.register(TrackingPlugin("core-2", "core"))
        await app.initialize(app_config)

        # Core plugins first, then normal, then deferred
        core_indices = [order.index(n) for n in order if n.startswith("core")]
        normal_indices = [order.index(n) for n in order if n.startswith("normal")]
        deferred_indices = [order.index(n) for n in order if n.startswith("deferred")]
        assert all(c < n for c in core_indices for n in normal_indices)
        assert all(n < d for n in normal_indices for d in deferred_indices)

    @pytest.mark.asyncio
    async def test_execute_through_plugin(self, app_config):
        """Full lifecycle: register, init, execute through interceptor chain."""

        class ComputePlugin(appkit.Plugin):
            def __init__(self):
                super().__init__(
                    "compute",
                    manifest=appkit.PluginManifest("compute"),
                )

        app = appkit.AppKit()
        plugin = ComputePlugin()
        app.register(plugin)
        await app.initialize(app_config)

        async def my_func():
            return '{"result": 42}'

        result = await plugin.execute(my_func, user_key="user-1")
        assert result.ok is True
        assert result.data is not None
        assert "42" in result.data
        assert bool(result) is True

    @pytest.mark.asyncio
    async def test_execute_error(self, app_config):
        app = appkit.AppKit()
        m = appkit.PluginManifest("err-plugin")
        p = appkit.Plugin("err-plugin", manifest=m)
        app.register(p)
        await app.initialize(app_config)

        async def failing_func():
            raise RuntimeError("something broke")

        result = await p.execute(failing_func)
        assert result.ok is False
        assert result.status == 500
        assert "something broke" in result.message
        assert bool(result) is False

    @pytest.mark.asyncio
    async def test_execute_with_cache(self, app_config):
        """Verify cache interceptor deduplicates calls."""
        call_count = 0

        app = appkit.AppKit()
        m = appkit.PluginManifest("cached")
        p = appkit.Plugin("cached", manifest=m)
        app.register(p)
        await app.initialize(app_config)

        async def compute():
            nonlocal call_count
            call_count += 1
            return '{"val": "computed"}'

        r1 = await p.execute(
            compute,
            user_key="u1",
            cache_key=["test-key"],
            cache_ttl=60,
        )
        assert r1.ok
        assert call_count == 1

        r2 = await p.execute(
            compute,
            user_key="u1",
            cache_key=["test-key"],
            cache_ttl=60,
        )
        assert r2.ok
        assert call_count == 1  # cache hit

    @pytest.mark.asyncio
    async def test_execute_with_timeout(self, app_config):
        import asyncio

        app = appkit.AppKit()
        m = appkit.PluginManifest("timeout-test")
        p = appkit.Plugin("timeout-test", manifest=m)
        app.register(p)
        await app.initialize(app_config)

        async def slow_func():
            await asyncio.sleep(10)
            return '"never"'

        result = await p.execute(slow_func, timeout_ms=50)
        assert result.ok is False
        assert result.status == 408
        assert "timed out" in result.message.lower()

    def test_shutdown_before_start_raises(self):
        app = appkit.AppKit()
        with pytest.raises(RuntimeError, match="not running"):
            app.shutdown()
