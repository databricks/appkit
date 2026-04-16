"""ServingPlugin — invoke and stream from Databricks model serving endpoints.

Routes mounted under ``/api/serving``:

- ``POST /invoke/:endpoint`` — invoke a configured endpoint (non-streaming).
- ``POST /stream/:endpoint`` — stream from a configured endpoint (SSE).

Endpoint aliases are resolved against :class:`ServingEndpointConfig` at
configuration time; the real endpoint name is read from the environment
variable named in ``ServingEndpointConfig.env`` so deployment and the plugin
config never hard-code served-model identifiers.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any

from appkit import (
    Plugin,
    PluginManifest,
    ServingConnector,
    StreamIterator,
    ValidationError,
)

from ._obo import obo_token, obo_user_key


class ServingEndpointConfig:
    """Per-alias serving endpoint configuration.

    ``env`` is the environment variable that holds the actual endpoint
    name (for example ``CHAT_ENDPOINT``). ``served_model`` optionally
    pins the request to a specific served model inside the endpoint.
    """

    __slots__ = ("env", "served_model")

    def __init__(self, *, env: str, served_model: str | None = None) -> None:
        if not env:
            raise ValueError("ServingEndpointConfig.env is required")
        self.env = env
        self.served_model = served_model

    def __repr__(self) -> str:
        return (
            f"ServingEndpointConfig(env={self.env!r}, "
            f"served_model={self.served_model!r})"
        )


class ServingPluginConfig:
    """Configuration for :class:`ServingPlugin`.

    ``endpoints`` maps alias → :class:`ServingEndpointConfig`. At least one
    endpoint is required.
    """

    __slots__ = ("endpoints", "host", "timeout_ms")

    def __init__(
        self,
        *,
        endpoints: Mapping[str, ServingEndpointConfig],
        host: str | None = None,
        timeout_ms: int | None = None,
    ) -> None:
        if not endpoints:
            raise ValueError("ServingPluginConfig requires at least one endpoint")
        self.endpoints: dict[str, ServingEndpointConfig] = dict(endpoints)
        self.host = host
        self.timeout_ms = timeout_ms

    def __repr__(self) -> str:
        return f"ServingPluginConfig(endpoints={sorted(self.endpoints)!r})"


class ServingPlugin(Plugin):
    """Model Serving plugin — invoke and stream endpoints via alias."""

    NAME = "serving"

    def __init__(self, config: ServingPluginConfig) -> None:
        super().__init__(
            self.NAME,
            manifest=PluginManifest(
                self.NAME,
                display_name="Model Serving Plugin",
                description=(
                    "Invoke and stream from Databricks serving endpoints"
                ),
            ),
        )
        host = config.host or os.environ.get("DATABRICKS_HOST")
        if not host:
            raise ValueError(
                "ServingPlugin requires a Databricks host. Set DATABRICKS_HOST "
                "or pass host= in ServingPluginConfig."
            )
        self._config = config
        self._host = host
        self._connector = ServingConnector(host)

    def client_config(self) -> dict[str, str]:
        return {"endpoints": ",".join(sorted(self._config.endpoints))}

    def inject_routes(self, router: Any) -> None:
        router.post("/invoke/:endpoint", self._handle_invoke)
        router.post("/stream/:endpoint", self._handle_stream, stream=True)

    def resolve_endpoint(self, alias: str) -> str:
        """Return the endpoint name for ``alias`` from the configured env var.

        Raises :class:`ValidationError` if the alias is unknown or the
        environment variable is unset or empty.
        """
        try:
            cfg = self._config.endpoints[alias]
        except KeyError as exc:
            raise ValidationError(
                f"Unknown endpoint alias {alias!r}. Configured: "
                f"{sorted(self._config.endpoints)!r}"
            ) from exc
        value = os.environ.get(cfg.env, "")
        if not value:
            raise ValidationError(
                f"Serving endpoint alias {alias!r} is configured to read from "
                f"environment variable {cfg.env!r}, but that variable is not set."
            )
        return value

    def _extract_alias(self, path: str) -> str:
        alias = path.rsplit("/", 1)[-1]
        if not alias:
            raise ValidationError("Missing endpoint alias in path")
        return alias

    def _merge_served_model(self, alias: str, body: Any) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise ValidationError("Request body must be a JSON object")
        cfg = self._config.endpoints[alias]
        if cfg.served_model and "served_model_name" not in body:
            body = dict(body)
            body["served_model_name"] = cfg.served_model
        return body

    async def _handle_invoke(self, request: Any) -> str:
        token = obo_token(request.headers)
        alias = self._extract_alias(request.path)
        endpoint = self.resolve_endpoint(alias)
        body = request.json() if request.body else {}
        body = self._merge_served_model(alias, body)

        async def run() -> str:
            response = await self._connector.invoke(
                token, endpoint, json.dumps(body)
            )
            return response.data

        result = await self.execute(
            run,
            user_key=obo_user_key(request.headers),
            timeout_ms=self._config.timeout_ms,
        )
        if not result.ok:
            raise RuntimeError(result.message or "Serving invocation failed")
        return result.data or "{}"

    async def _handle_stream(self, request: Any) -> StreamIterator:
        token = obo_token(request.headers)
        alias = self._extract_alias(request.path)
        endpoint = self.resolve_endpoint(alias)
        body = request.json() if request.body else {}
        body = self._merge_served_model(alias, body)

        return await self._connector.stream(token, endpoint, json.dumps(body))


__all__ = ["ServingPlugin", "ServingPluginConfig", "ServingEndpointConfig"]
