"""AppKit core — create_app() factory.

Mirrors packages/appkit/src/core/appkit.ts

Usage:
    from appkit_py.core.appkit import create_app
    from appkit_py.plugins.server.plugin import server
    from appkit_py.plugins.analytics.plugin import analytics
    from appkit_py.plugins.files.plugin import files
    from appkit_py.plugins.genie.plugin import genie

    appkit = await create_app(
        plugins=[
            server({"autoStart": False}),
            analytics({}),
            files(),
            genie({"spaces": {"demo": "space-id"}}),
        ]
    )
    appkit.server.extend(lambda app: ...).start()
"""

from __future__ import annotations

import logging
import os
from typing import Any

from appkit_py.cache.cache_manager import CacheManager
from appkit_py.context.service_context import ServiceContext
from appkit_py.plugin.plugin import Plugin

logger = logging.getLogger("appkit.core")


class AppKit:
    """The AppKit instance returned by create_app().

    Provides attribute access to plugin exports: appkit.analytics.query(...).
    """

    def __init__(self, plugins: dict[str, Plugin]) -> None:
        self._plugins = plugins

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        plugin = self._plugins.get(name)
        if plugin is None:
            raise AttributeError(f"No plugin named '{name}'. Available: {list(self._plugins.keys())}")
        # Return a namespace object with the plugin's exports + as_user
        exports = plugin.exports()
        ns = _PluginNamespace(plugin, exports)
        return ns


class _PluginNamespace:
    """Namespace for a plugin's exports, supporting .asUser(req) chaining."""

    def __init__(self, plugin: Plugin, exports: dict[str, Any]) -> None:
        self._plugin = plugin
        self._exports = exports

    def __getattr__(self, name: str) -> Any:
        if name == "asUser":
            return self._plugin.as_user
        if name in self._exports:
            return self._exports[name]
        raise AttributeError(f"Plugin '{self._plugin.name}' has no export '{name}'")

    def __call__(self, *args, **kwargs):
        # Support callable plugins like files("volumeKey")
        if callable(self._exports.get("__call__")):
            return self._exports["__call__"](*args, **kwargs)
        raise TypeError(f"Plugin '{self._plugin.name}' is not callable")


async def create_app(
    plugins: list[Plugin] | None = None,
    *,
    client: Any = None,
) -> AppKit:
    """Create an AppKit application from a list of plugins.

    Mirrors the TS createApp() factory:
    1. Initialize CacheManager
    2. Initialize ServiceContext
    3. Instantiate plugins in phase order (core → normal → deferred)
    4. Call setup() on each plugin
    5. Return AppKit instance with plugin attribute access

    Args:
        plugins: List of plugin instances (from to_plugin factories).
        client: Optional pre-configured WorkspaceClient (for testing).
    """
    all_plugins = plugins or []

    # 1. Initialize cache
    CacheManager.reset()
    cache = CacheManager.get_instance()

    # 2. Initialize service context + workspace client
    ServiceContext.reset()
    ServiceContext.initialize()

    ws_client = client
    if ws_client is None:
        host = os.environ.get("DATABRICKS_HOST")
        if host:
            try:
                from databricks.sdk import WorkspaceClient
                ws_client = WorkspaceClient()
                user = ws_client.current_user.me()
                logger.info("Connected as %s", user.user_name)
            except Exception as exc:
                logger.warning("Failed to create WorkspaceClient: %s", exc)

    # 3. Sort plugins by phase
    phase_order = {"core": 0, "normal": 1, "deferred": 2}
    sorted_plugins = sorted(all_plugins, key=lambda p: phase_order.get(p.phase, 1))

    # Build plugin map (excluding server)
    from appkit_py.plugins.server.plugin import ServerPlugin
    plugin_map: dict[str, Plugin] = {}
    server_plugin: ServerPlugin | None = None

    for plugin in sorted_plugins:
        plugin.set_workspace_client(ws_client)
        if isinstance(plugin, ServerPlugin):
            server_plugin = plugin
        else:
            plugin_map[plugin.name] = plugin

    # 4. Inject non-server plugins into server, then setup all
    if server_plugin:
        server_plugin.set_workspace_client(ws_client)
        server_plugin.set_plugins(plugin_map)
        plugin_map["server"] = server_plugin

    for plugin in sorted_plugins:
        await plugin.setup()

    logger.info(
        "AppKit initialized with plugins: %s",
        ", ".join(plugin_map.keys()),
    )

    return AppKit(plugin_map)
