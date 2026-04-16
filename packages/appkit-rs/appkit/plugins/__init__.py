"""Shipped AppKit plugins — Python subclasses of ``appkit.Plugin``.

These wrap the Rust connectors with route injection, per-plugin config,
and OBO (on-behalf-of) token handling so apps can register real plugins
instead of raw connectors.
"""

from .analytics import AnalyticsPlugin, AnalyticsPluginConfig
from .files import FilesPlugin, FilesPluginConfig, VolumeConfig
from .genie import GeniePlugin, GeniePluginConfig
from .lakebase import LakebasePlugin, LakebasePluginConfig
from .server import ServerPlugin, ServerPluginConfig
from .serving import (
    ServingEndpointConfig,
    ServingPlugin,
    ServingPluginConfig,
)
from .vector_search import (
    VectorSearchIndexConfig,
    VectorSearchPlugin,
    VectorSearchPluginConfig,
)


def analytics(config: AnalyticsPluginConfig) -> AnalyticsPlugin:
    """Construct an :class:`AnalyticsPlugin` — the plugin entry point."""
    return AnalyticsPlugin(config)


def vector_search(config: VectorSearchPluginConfig) -> VectorSearchPlugin:
    """Construct a :class:`VectorSearchPlugin` — the plugin entry point."""
    return VectorSearchPlugin(config)


def server(config: ServerPluginConfig | None = None) -> ServerPlugin:
    """Construct a :class:`ServerPlugin` — the plugin entry point."""
    return ServerPlugin(config)


def files(config: FilesPluginConfig) -> FilesPlugin:
    """Construct a :class:`FilesPlugin` — the plugin entry point."""
    return FilesPlugin(config)


def genie(config: GeniePluginConfig) -> GeniePlugin:
    """Construct a :class:`GeniePlugin` — the plugin entry point."""
    return GeniePlugin(config)


def serving(config: ServingPluginConfig) -> ServingPlugin:
    """Construct a :class:`ServingPlugin` — the plugin entry point."""
    return ServingPlugin(config)


def lakebase(config: LakebasePluginConfig | None = None) -> LakebasePlugin:
    """Construct a :class:`LakebasePlugin` — the plugin entry point."""
    return LakebasePlugin(config)


__all__ = [
    "AnalyticsPlugin",
    "AnalyticsPluginConfig",
    "FilesPlugin",
    "FilesPluginConfig",
    "VolumeConfig",
    "GeniePlugin",
    "GeniePluginConfig",
    "ServingPlugin",
    "ServingPluginConfig",
    "ServingEndpointConfig",
    "LakebasePlugin",
    "LakebasePluginConfig",
    "ServerPlugin",
    "ServerPluginConfig",
    "VectorSearchPlugin",
    "VectorSearchPluginConfig",
    "VectorSearchIndexConfig",
    "analytics",
    "vector_search",
    "server",
    "files",
    "genie",
    "serving",
    "lakebase",
]
