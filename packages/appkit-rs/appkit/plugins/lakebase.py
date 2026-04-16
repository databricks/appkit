"""LakebasePlugin — Databricks Lakebase (PostgreSQL) integration.

Lakebase exposes a programmatic pool API rather than HTTP routes, so this
plugin publishes connection helpers through plugin attributes and
``exports()`` rather than via ``inject_routes``. The corresponding Rust
:class:`crate::plugins::lakebase::LakebasePluginCore` declares the
``postgres`` resource requirement for manifest parity.

Typical usage::

    lakebase = LakebasePlugin(LakebasePluginConfig())
    app = await create_app(plugins=[lakebase, ...], config=AppConfig.from_env())

    # Inside a route handler running under OBO:
    credential = await lakebase.generate_credential(
        obo_token(request.headers),
        instance_names=[lakebase.pg_config.host],
    )
    # Pass `credential.token` as the PostgreSQL password for this request.
"""

from __future__ import annotations

import os
from typing import Any

from appkit import (
    DatabaseCredential,
    LakebaseConnector,
    LakebasePgConfig,
    Plugin,
    PluginManifest,
)


class LakebasePluginConfig:
    """Configuration for :class:`LakebasePlugin`.

    ``pg_config`` overrides the default :class:`LakebasePgConfig` built
    from ``PGHOST``/``PGDATABASE``/``LAKEBASE_ENDPOINT`` etc. ``host``
    defaults to ``DATABRICKS_HOST`` and is used to reach the Lakebase
    credential-generation REST API (distinct from the PG host).
    """

    __slots__ = ("pg_config", "host")

    def __init__(
        self,
        *,
        pg_config: LakebasePgConfig | None = None,
        host: str | None = None,
    ) -> None:
        self.pg_config = pg_config
        self.host = host

    def __repr__(self) -> str:
        return f"LakebasePluginConfig(pg_config={self.pg_config!r})"


class LakebasePlugin(Plugin):
    """Lakebase PostgreSQL integration plugin.

    Exposes:

    - :attr:`pg_config` — resolved :class:`LakebasePgConfig` for pool setup.
    - :attr:`connector` — the underlying :class:`LakebaseConnector`.
    - :meth:`generate_credential` — wrapper around the REST call.
    """

    NAME = "lakebase"

    def __init__(self, config: LakebasePluginConfig | None = None) -> None:
        super().__init__(
            self.NAME,
            manifest=PluginManifest(
                self.NAME,
                display_name="Lakebase",
                description="Databricks Lakebase PostgreSQL integration",
            ),
        )
        config = config or LakebasePluginConfig()
        host = config.host or os.environ.get("DATABRICKS_HOST")
        if not host:
            raise ValueError(
                "LakebasePlugin requires a Databricks host. Set DATABRICKS_HOST "
                "or pass host= in LakebasePluginConfig."
            )
        self._config = config
        self._host = host
        self._pg_config = config.pg_config or LakebasePgConfig()
        self._connector = LakebaseConnector(host)

    @property
    def pg_config(self) -> LakebasePgConfig:
        return self._pg_config

    @property
    def connector(self) -> LakebaseConnector:
        return self._connector

    async def generate_credential(
        self,
        token: str,
        instance_names: list[str] | None = None,
        *,
        request_id: str | None = None,
    ) -> DatabaseCredential:
        """Generate a short-lived credential for Lakebase connection(s).

        When ``instance_names`` is omitted, the plugin's configured PG host
        is used as the single instance name.
        """
        names = list(instance_names) if instance_names else [self._pg_config.host]
        return await self._connector.generate_credential(
            token, names, request_id=request_id
        )

    def client_config(self) -> dict[str, str]:
        return {
            "database": self._pg_config.database,
            "ssl_mode": self._pg_config.ssl_mode,
        }

    def exports(self) -> dict[str, str]:
        return {
            "pg_host": self._pg_config.host,
            "pg_database": self._pg_config.database,
            "pg_port": str(self._pg_config.port),
            "pg_ssl_mode": self._pg_config.ssl_mode,
        }

    def inject_routes(self, _router: Any) -> None:
        return None


__all__ = ["LakebasePlugin", "LakebasePluginConfig"]
