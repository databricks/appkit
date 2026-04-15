"""Main server entry point — thin wrapper around the plugin-based architecture.

Usage with uvicorn:
    uvicorn appkit_py.server:app

Usage programmatically (matching TS dev-playground/server/index.ts):
    from appkit_py.core.appkit import create_app
    from appkit_py.plugins.server.plugin import server, ServerPlugin
    from appkit_py.plugins.analytics.plugin import analytics
    from appkit_py.plugins.files.plugin import files
    from appkit_py.plugins.genie.plugin import genie

    appkit = await create_app(plugins=[
        server({"autoStart": False}),
        analytics({}),
        files(),
        genie({"spaces": {"demo": "space-id"}}),
    ])
    appkit.server.extend(lambda app: app.get("/custom", ...))
    await appkit.server.start()
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI

from appkit_py.core.appkit import create_app
from appkit_py.plugin.plugin import Plugin
from appkit_py.plugins.analytics.plugin import AnalyticsPlugin
from appkit_py.plugins.files.plugin import FilesPlugin
from appkit_py.plugins.genie.plugin import GeniePlugin
from appkit_py.plugins.server.plugin import ServerPlugin

logger = logging.getLogger("appkit.server")


def create_server(
    *,
    query_dir: str | None = None,
    static_path: str | None = None,
    genie_spaces: dict[str, str] | None = None,
    volumes: dict[str, str] | None = None,
):
    """Create the FastAPI app using the plugin architecture.

    This is the convenience function for uvicorn. For full control,
    use create_app() directly.
    """
    server_config: dict = {"autoStart": False}
    if static_path:
        server_config["staticPath"] = static_path

    analytics_config: dict = {}
    if query_dir:
        analytics_config["query_dir"] = query_dir

    files_config: dict = {}
    if volumes:
        files_config["volumes"] = volumes

    genie_config: dict = {}
    if genie_spaces:
        genie_config["spaces"] = genie_spaces

    plugins = [
        ServerPlugin(server_config),
        AnalyticsPlugin(analytics_config),
        FilesPlugin(files_config),
        GeniePlugin(genie_config),
    ]

    # Synchronous initialization: manually run setup steps without asyncio.run()
    # This avoids "Cannot run event loop while another is running" when
    # imported by uvicorn (which already has an event loop).
    import os
    from appkit_py.cache.cache_manager import CacheManager
    from appkit_py.context.service_context import ServiceContext

    CacheManager.reset()
    CacheManager.get_instance()
    ServiceContext.reset()
    ServiceContext.initialize()

    # Create workspace client
    ws_client = None
    host = os.environ.get("DATABRICKS_HOST")
    if host:
        try:
            from databricks.sdk import WorkspaceClient
            ws_client = WorkspaceClient()
        except Exception as exc:
            logger.warning("Failed to create WorkspaceClient: %s", exc)

    # Wire up plugins (sync parts)
    phase_order = {"core": 0, "normal": 1, "deferred": 2}
    sorted_plugins = sorted(plugins, key=lambda p: phase_order.get(p.phase, 1))
    plugin_map: dict[str, Plugin] = {}
    server_plugin: ServerPlugin | None = None

    for plugin in sorted_plugins:
        plugin.set_workspace_client(ws_client)
        if isinstance(plugin, ServerPlugin):
            server_plugin = plugin
        else:
            plugin_map[plugin.name] = plugin

    if server_plugin:
        server_plugin.set_workspace_client(ws_client)
        server_plugin.set_plugins(plugin_map)
        plugin_map["server"] = server_plugin

    # Run async setup via startup event (runs when uvicorn starts the event loop)
    app = server_plugin.app if server_plugin else FastAPI()

    @app.on_event("startup")
    async def _run_plugin_setup():
        for plugin in sorted_plugins:
            await plugin.setup()
        logger.info("AppKit plugins initialized: %s", ", ".join(plugin_map.keys()))

    return app


# Module-level app for `uvicorn appkit_py.server:app`
app = create_server()
