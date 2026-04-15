"""Server plugin — orchestrates the FastAPI application.

Mirrors packages/appkit/src/plugins/server/index.ts
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import signal
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from appkit_py.plugin.plugin import Plugin, to_plugin
from appkit_py.stream.sse_writer import SSE_HEADERS, format_event

logger = logging.getLogger("appkit.server")


class ServerPlugin(Plugin):
    name = "server"
    phase = "deferred"  # Initialized last, after all other plugins

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self.app = FastAPI(title="AppKit Python Backend")
        self._plugins: dict[str, Plugin] = {}
        self._host = self.config.get("host") or os.environ.get("FLASK_RUN_HOST", "0.0.0.0")
        self._port = int(self.config.get("port") or os.environ.get("DATABRICKS_APP_PORT", "8000"))
        self._auto_start = self.config.get("autoStart", True)
        self._static_path = self.config.get("staticPath")

    def set_plugins(self, plugins: dict[str, Plugin]) -> None:
        """Called by create_app to inject all other plugins."""
        self._plugins = plugins

    async def setup(self) -> None:
        # Register /health
        @self.app.get("/health")
        async def health():
            return {"status": "ok"}

        # Reconnect test endpoint (matches TS dev-playground)
        @self.app.get("/api/reconnect/stream")
        async def reconnect_stream(request: Request):
            async def gen() -> AsyncGenerator[str, None]:
                for i in range(1, 6):
                    eid = str(uuid.uuid4())
                    yield format_event(eid, {"type": "message", "count": i, "total": 5, "message": f"Event {i} of 5"})
                    await asyncio.sleep(0.1)
            return StreamingResponse(gen(), media_type="text/event-stream",
                                     headers={k: v for k, v in SSE_HEADERS.items() if k != "Content-Type"})

        # Mount each plugin's routes under /api/{plugin.name}
        for plugin in self._plugins.values():
            router = plugin.router
            plugin.inject_routes(router)
            self.app.include_router(router, prefix=f"/api/{plugin.name}")

        # Static file serving with config injection
        self._setup_static_serving()

    def _setup_static_serving(self) -> None:
        static_dir = self._static_path or self._find_static_dir()
        if not static_dir or not Path(static_dir).is_dir():
            return

        _static = Path(static_dir)
        _index = _static / "index.html"

        # Build client config from all plugins
        endpoints = {}
        plugin_configs = {}
        for p in self._plugins.values():
            endpoints[p.name] = p.get_endpoints()
            cc = p.client_config()
            if cc:
                plugin_configs[p.name] = cc

        config_json = json.dumps({
            "appName": os.environ.get("DATABRICKS_APP_NAME", "appkit-py"),
            "queries": {},
            "endpoints": endpoints,
            "plugins": plugin_configs,
        })
        safe_config = config_json.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")

        @self.app.get("/{full_path:path}")
        async def serve_spa(full_path: str):
            file_path = (_static / full_path).resolve()
            static_root = _static.resolve()
            if file_path.is_file() and str(file_path).startswith(str(static_root) + os.sep):
                ct = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
                return Response(content=file_path.read_bytes(), media_type=ct)

            if _index.is_file():
                html = _index.read_text()
                script = (
                    f'<script id="__appkit__" type="application/json">{safe_config}</script>\n'
                    '<script>window.__appkit__=JSON.parse(document.getElementById("__appkit__")?.textContent||"{}")</script>'
                )
                if "</head>" in html:
                    html = html.replace("</head>", f"{script}\n</head>")
                else:
                    html = script + "\n" + html
                return Response(content=html, media_type="text/html")

            return JSONResponse({"error": "Not found"}, status_code=404)

    @staticmethod
    def _find_static_dir() -> str | None:
        for candidate in ["client/dist", "dist", "build", "public", "out", "../client/dist"]:
            if Path(candidate).is_dir():
                return candidate
        return None

    def extend(self, fn) -> ServerPlugin:
        """Add custom routes/middleware (matching TS server.extend())."""
        fn(self.app)
        return self

    async def start(self) -> FastAPI:
        """Start the server (matching TS server.start())."""
        import uvicorn
        config = uvicorn.Config(self.app, host=self._host, port=self._port, log_level="info")
        srv = uvicorn.Server(config)
        await srv.serve()
        return self.app

    def get_app(self) -> FastAPI:
        """Get the FastAPI application instance."""
        return self.app

    def exports(self) -> dict[str, Any]:
        return {
            "start": self.start,
            "extend": self.extend,
            "getApp": self.get_app,
        }

    async def shutdown(self) -> None:
        # Abort all plugin streams
        for p in self._plugins.values():
            p.stream_manager.abort_all()
        self.stream_manager.abort_all()


server = to_plugin(ServerPlugin)
