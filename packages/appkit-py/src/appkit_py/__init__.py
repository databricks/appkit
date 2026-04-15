"""Python backend for Databricks AppKit — 100% API compatible with the TypeScript version.

Usage (mirrors TS):
    from appkit_py import create_app, server, analytics, files, genie

    appkit = await create_app(plugins=[
        server({"autoStart": False}),
        analytics({}),
        files(),
        genie({"spaces": {"demo": "space-id"}}),
    ])
"""

from appkit_py.core.appkit import create_app
from appkit_py.plugin.plugin import Plugin, to_plugin
from appkit_py.plugins.analytics.plugin import analytics
from appkit_py.plugins.files.plugin import files
from appkit_py.plugins.genie.plugin import genie
from appkit_py.plugins.server.plugin import server

__all__ = [
    "create_app",
    "Plugin",
    "to_plugin",
    "server",
    "analytics",
    "files",
    "genie",
]
