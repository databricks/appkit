"""FilesPlugin — Python wrapper around the Rust ``FilesConnector``.

Registers one :class:`FilesConnector` per configured volume alias and exposes
Unity Catalog Volumes operations over HTTP routes mounted at
``/api/files/...``. Every route requires an OBO token forwarded by Databricks
Apps (``X-Forwarded-Access-Token``).
"""

from __future__ import annotations

import base64
import json
import os
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qs

from appkit import FilesConnector, Plugin, PluginManifest

from ._obo import obo_token


class VolumeConfig:
    """Per-volume alias configuration.

    ``path`` is the fully-qualified Unity Catalog volume path, for example
    ``/Volumes/catalog/schema/volume``.
    """

    __slots__ = ("path", "max_upload_size")

    def __init__(self, *, path: str, max_upload_size: int | None = None) -> None:
        if not path:
            raise ValueError("VolumeConfig.path is required")
        self.path = path
        self.max_upload_size = max_upload_size

    def __repr__(self) -> str:
        return (
            f"VolumeConfig(path={self.path!r}, "
            f"max_upload_size={self.max_upload_size!r})"
        )


class FilesPluginConfig:
    """Configuration for :class:`FilesPlugin`.

    ``volumes`` maps alias → :class:`VolumeConfig`. Aliases appear in route
    URLs as the ``volume`` query parameter (for example
    ``/api/files/list?volume=uploads``). ``host`` defaults to the
    ``DATABRICKS_HOST`` environment variable.
    """

    __slots__ = ("volumes", "host", "timeout_ms", "max_upload_size")

    def __init__(
        self,
        *,
        volumes: Mapping[str, VolumeConfig],
        host: str | None = None,
        timeout_ms: int | None = None,
        max_upload_size: int | None = None,
    ) -> None:
        if not volumes:
            raise ValueError("FilesPluginConfig requires at least one volume")
        self.volumes: dict[str, VolumeConfig] = dict(volumes)
        self.host = host
        self.timeout_ms = timeout_ms
        self.max_upload_size = max_upload_size

    def __repr__(self) -> str:
        return (
            f"FilesPluginConfig(volumes={sorted(self.volumes)!r}, "
            f"host={self.host!r})"
        )


def _query(request: Any) -> dict[str, str]:
    parsed = parse_qs(request.query, keep_blank_values=True)
    return {k: v[0] for k, v in parsed.items() if v}


class FilesPlugin(Plugin):
    """Unity Catalog Volumes file operations plugin."""

    NAME = "files"

    def __init__(self, config: FilesPluginConfig) -> None:
        super().__init__(
            self.NAME,
            manifest=PluginManifest(
                self.NAME,
                display_name="Files Plugin",
                description="Unity Catalog Volumes file operations",
            ),
        )
        host = config.host or os.environ.get("DATABRICKS_HOST")
        if not host:
            raise ValueError(
                "FilesPlugin requires a Databricks host. Set DATABRICKS_HOST "
                "or pass host= in FilesPluginConfig."
            )
        self._config = config
        self._host = host
        self._connectors: dict[str, FilesConnector] = {
            alias: FilesConnector(host, default_volume=vcfg.path)
            for alias, vcfg in config.volumes.items()
        }

    def client_config(self) -> dict[str, str]:
        return {"volumes": ",".join(sorted(self._config.volumes))}

    def inject_routes(self, router: Any) -> None:
        router.get("/volumes", self._handle_volumes)
        router.get("/list", self._handle_list)
        router.get("/read", self._handle_read)
        router.get("/metadata", self._handle_metadata)
        router.get("/exists", self._handle_exists)
        router.get("/preview", self._handle_preview)
        router.post("/mkdir", self._handle_mkdir)
        router.delete("/delete", self._handle_delete)
        router.post("/upload", self._handle_upload)

    def connector(self, volume_key: str) -> FilesConnector:
        """Return the :class:`FilesConnector` registered for ``volume_key``.

        Raises :class:`ValueError` when the alias is not configured.
        """
        try:
            return self._connectors[volume_key]
        except KeyError as exc:
            raise ValueError(
                f"Unknown volume {volume_key!r}. Configured: "
                f"{sorted(self._connectors)!r}"
            ) from exc

    def _resolve(
        self, request: Any, *, require_path: bool = False
    ) -> tuple[FilesConnector, str, str | None]:
        token = obo_token(request.headers)
        params = _query(request)
        volume_key = params.get("volume")
        if not volume_key:
            raise ValueError("Missing required query parameter 'volume'")
        connector = self.connector(volume_key)
        path = params.get("path")
        if require_path and not path:
            raise ValueError("Missing required query parameter 'path'")
        return connector, token, path

    async def _handle_volumes(self, _request: Any) -> str:
        return json.dumps({"volumes": sorted(self._config.volumes)})

    async def _handle_list(self, request: Any) -> str:
        connector, token, path = self._resolve(request)
        entries = await connector.list(token, directory_path=path)
        payload = [
            {
                "path": e.path,
                "name": e.name,
                "is_directory": e.is_directory,
                "file_size": e.file_size,
                "last_modified": e.last_modified,
            }
            for e in entries
        ]
        return json.dumps({"entries": payload})

    async def _handle_read(self, request: Any) -> str:
        connector, token, path = self._resolve(request, require_path=True)
        content = await connector.read(token, path)
        return json.dumps({"content": content})

    async def _handle_metadata(self, request: Any) -> str:
        connector, token, path = self._resolve(request, require_path=True)
        meta = await connector.metadata(token, path)
        return json.dumps(
            {
                "content_length": meta.content_length,
                "content_type": meta.content_type,
                "last_modified": meta.last_modified,
            }
        )

    async def _handle_exists(self, request: Any) -> str:
        connector, token, path = self._resolve(request, require_path=True)
        exists = await connector.exists(token, path)
        return json.dumps({"exists": exists})

    async def _handle_preview(self, request: Any) -> str:
        connector, token, path = self._resolve(request, require_path=True)
        params = _query(request)
        max_chars_raw = params.get("max_chars", "1024")
        try:
            max_chars = int(max_chars_raw)
        except ValueError as exc:
            raise ValueError(f"Invalid max_chars: {max_chars_raw!r}") from exc
        preview = await connector.preview(token, path, max_chars=max_chars)
        return json.dumps(
            {
                "content_length": preview.content_length,
                "content_type": preview.content_type,
                "last_modified": preview.last_modified,
                "text_preview": preview.text_preview,
                "is_text": preview.is_text,
                "is_image": preview.is_image,
            }
        )

    async def _handle_mkdir(self, request: Any) -> str:
        token = obo_token(request.headers)
        body = request.json()
        if not isinstance(body, dict):
            raise ValueError("mkdir body must be a JSON object")
        volume_key = body.get("volume")
        path = body.get("path")
        if not volume_key or not path:
            raise ValueError("mkdir requires 'volume' and 'path' fields")
        await self.connector(volume_key).create_directory(token, path)
        return json.dumps({"created": path})

    async def _handle_delete(self, request: Any) -> str:
        connector, token, path = self._resolve(request, require_path=True)
        await connector.delete(token, path)
        return json.dumps({"deleted": path})

    async def _handle_upload(self, request: Any) -> str:
        token = obo_token(request.headers)
        body = request.json()
        if not isinstance(body, dict):
            raise ValueError("upload body must be a JSON object")
        volume_key = body.get("volume")
        path = body.get("path")
        contents_b64 = body.get("contents_base64")
        overwrite = bool(body.get("overwrite", True))
        if not volume_key or not path or contents_b64 is None:
            raise ValueError(
                "upload requires 'volume', 'path', and 'contents_base64' fields"
            )
        try:
            contents = base64.b64decode(contents_b64, validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise ValueError(f"contents_base64 is not valid base64: {exc}") from exc
        max_size = self._config.volumes[volume_key].max_upload_size or (
            self._config.max_upload_size
        )
        if max_size is not None and len(contents) > max_size:
            raise ValueError(
                f"Upload size {len(contents)} exceeds max {max_size} bytes"
            )
        await self.connector(volume_key).upload(
            token, path, contents, overwrite=overwrite
        )
        return json.dumps({"uploaded": path, "size": len(contents)})


__all__ = ["FilesPlugin", "FilesPluginConfig", "VolumeConfig"]
