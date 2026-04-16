"""ServerPlugin — Python face of the core HTTP server.

The actual axum-backed server lives in the Rust crate (``crate::server``)
and is started by :func:`appkit.create_app` / ``AppKit.start_server``.
This plugin exists so apps can declare the server in their plugin list,
tune host/port/static-file settings, and participate in phase ordering
(the server plugin runs in the Core phase — before any Normal plugin
injects routes).

``ServerPlugin.to_server_config()`` returns the :class:`appkit.ServerConfig`
that ``create_app`` should hand to ``start_server``.
"""

from __future__ import annotations

from typing import Any

from appkit import Plugin, PluginManifest, PluginPhase, ServerConfig


class ServerPluginConfig:
    """Configuration for :class:`ServerPlugin`.

    Mirrors :class:`appkit.ServerConfig`. Defaults align with the Rust
    ``ServerPluginConfig`` (``0.0.0.0:8000``, auto-start enabled).
    """

    __slots__ = ("host", "port", "auto_start", "static_path")

    def __init__(
        self,
        *,
        host: str = "0.0.0.0",
        port: int = 8000,
        auto_start: bool = True,
        static_path: str | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.auto_start = auto_start
        self.static_path = static_path

    def __repr__(self) -> str:
        return f"ServerPluginConfig(host={self.host!r}, port={self.port})"


class ServerPlugin(Plugin):
    """Core HTTP server plugin.

    The server plugin runs in the Core phase so that the server is ready
    before any Normal-phase plugin calls ``inject_routes``. It exposes no
    routes of its own — route hosting is handled by ``AppKit.start_server``.
    """

    NAME = "server"

    def __init__(self, config: ServerPluginConfig | None = None) -> None:
        super().__init__(
            self.NAME,
            phase=PluginPhase.CORE,
            manifest=PluginManifest(
                self.NAME,
                display_name="Server Plugin",
                description=(
                    "HTTP server with axum route hosting, SSE streaming, "
                    "and graceful shutdown"
                ),
            ),
        )
        self._config = config or ServerPluginConfig()

    @property
    def config(self) -> ServerPluginConfig:
        return self._config

    def to_server_config(self) -> ServerConfig:
        """Convert plugin config into an :class:`appkit.ServerConfig`."""
        return ServerConfig(
            host=self._config.host,
            port=self._config.port,
            auto_start=self._config.auto_start,
            static_path=self._config.static_path,
        )

    def client_config(self) -> dict[str, str]:
        return {}

    def inject_routes(self, _router: Any) -> None:
        return None


__all__ = ["ServerPlugin", "ServerPluginConfig"]
