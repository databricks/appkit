"""Files plugin for Unity Catalog Volume operations.

Mirrors packages/appkit/src/plugins/files/plugin.ts
"""

from __future__ import annotations

import logging
import mimetypes
import os
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from appkit_py.connectors.files.client import FilesConnector
from appkit_py.plugin.plugin import Plugin, to_plugin

logger = logging.getLogger("appkit.files")

_FILES_MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024  # 5GB


def _validate_path(path: str | None) -> str | None:
    """Validate a file/directory path. Returns error string or None if valid."""
    if not path:
        return "path is required"
    if len(path) > 4096:
        return f"path exceeds maximum length of 4096 characters (got {len(path)})"
    if "\0" in path:
        return "path must not contain null bytes"
    return None


def _sanitize_filename(raw: str) -> str:
    return "".join(c for c in raw if c.isalnum() or c in "._- ")[:255] or "download"


class FilesPlugin(Plugin):
    name = "files"
    phase = "normal"

    default_cache_ttl = 300
    default_retry_attempts = 2
    default_timeout = 30.0

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self._volumes = self._discover_volumes()
        self._connectors: dict[str, FilesConnector] = {
            key: FilesConnector(default_volume=path)
            for key, path in self._volumes.items()
        }
        self._max_upload_size = self.config.get("maxUploadSize", _FILES_MAX_UPLOAD_SIZE)

    def _discover_volumes(self) -> dict[str, str]:
        explicit = self.config.get("volumes", {})
        discovered: dict[str, str] = {}
        prefix = "DATABRICKS_VOLUME_"
        for key, value in os.environ.items():
            if key.startswith(prefix) and value:
                suffix = key[len(prefix):]
                if suffix:
                    vol_key = suffix.lower()
                    if vol_key not in explicit:
                        discovered[vol_key] = value
        return {**discovered, **{k: v for k, v in explicit.items() if isinstance(v, str)}}

    def inject_routes(self, router: APIRouter) -> None:
        self.route(router, name="volumes", method="get", path="/volumes",
                   handler=self._handle_volumes)
        self.route(router, name="list", method="get", path="/{volume_key}/list",
                   handler=self._handle_list)
        self.route(router, name="read", method="get", path="/{volume_key}/read",
                   handler=self._handle_read)
        self.route(router, name="download", method="get", path="/{volume_key}/download",
                   handler=self._handle_download)
        self.route(router, name="raw", method="get", path="/{volume_key}/raw",
                   handler=self._handle_raw)
        self.route(router, name="exists", method="get", path="/{volume_key}/exists",
                   handler=self._handle_exists)
        self.route(router, name="metadata", method="get", path="/{volume_key}/metadata",
                   handler=self._handle_metadata)
        self.route(router, name="preview", method="get", path="/{volume_key}/preview",
                   handler=self._handle_preview)
        self.route(router, name="upload", method="post", path="/{volume_key}/upload",
                   handler=self._handle_upload, skip_body_parsing=True)
        self.route(router, name="mkdir", method="post", path="/{volume_key}/mkdir",
                   handler=self._handle_mkdir)
        self.route(router, name="delete", method="delete", path="/{volume_key}",
                   handler=self._handle_delete)

    def _resolve(self, volume_key: str, request: Request):
        """Resolve volume connector + user client, or return error response."""
        connector = self._connectors.get(volume_key)
        if not connector:
            safe = "".join(c for c in volume_key if c.isalnum() or c in "_-")
            return None, None, JSONResponse(
                {"error": f'Unknown volume "{safe}"', "plugin": self.name}, status_code=404
            )
        client = self.get_workspace_client(request)
        if not client:
            return None, None, JSONResponse(
                {"error": "Databricks connection not configured", "plugin": self.name},
                status_code=500,
            )
        return connector, client, None

    def _check_path(self, path: str | None):
        err = _validate_path(path)
        if err:
            return JSONResponse({"error": err, "plugin": self.name}, status_code=400)
        return None

    def _api_error(self, exc: Exception, fallback: str) -> JSONResponse:
        status = getattr(exc, "status_code", 500)
        if isinstance(status, int) and 400 <= status < 500:
            return JSONResponse({"error": str(exc), "statusCode": status, "plugin": self.name}, status_code=status)
        return JSONResponse({"error": fallback, "plugin": self.name}, status_code=500)

    # --- Route handlers ---

    async def _handle_volumes(self):
        return {"volumes": list(self._volumes.keys())}

    async def _handle_list(self, volume_key: str, request: Request, path: str | None = None):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        try:
            result = await self.execute(
                lambda: connector.list(client, path),
                cache_key=[f"files:{volume_key}:list", path or "__root__"],
            )
            return result
        except Exception as exc:
            return self._api_error(exc, "List failed")

    async def _handle_read(self, volume_key: str, request: Request, path: str | None = None):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        path_err = self._check_path(path)
        if path_err:
            return path_err
        try:
            result = await self.execute(
                lambda: connector.read(client, path),
                cache_key=[f"files:{volume_key}:read", path],
            )
            return Response(content=result, media_type="text/plain")
        except Exception as exc:
            return self._api_error(exc, "Read failed")

    async def _handle_download(self, volume_key: str, request: Request, path: str | None = None):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        path_err = self._check_path(path)
        if path_err:
            return path_err
        try:
            result = await self.execute(
                lambda: connector.download(client, path),
                cache_enabled=False, retry_attempts=1, timeout=60.0,
            )
            ct = result.get("content_type") or mimetypes.guess_type(path)[0] or "application/octet-stream"
            filename = _sanitize_filename(path.split("/")[-1] if path else "download")
            content = result.get("contents")
            body = content.read() if hasattr(content, "read") else (content or b"")
            return Response(content=body, media_type=ct, headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Content-Type-Options": "nosniff",
            })
        except Exception as exc:
            return self._api_error(exc, "Download failed")

    async def _handle_raw(self, volume_key: str, request: Request, path: str | None = None):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        path_err = self._check_path(path)
        if path_err:
            return path_err
        try:
            result = await self.execute(
                lambda: connector.download(client, path),
                cache_enabled=False, retry_attempts=1, timeout=60.0,
            )
            ct = result.get("content_type") or mimetypes.guess_type(path)[0] or "application/octet-stream"
            content = result.get("contents")
            body = content.read() if hasattr(content, "read") else (content or b"")
            return Response(content=body, media_type=ct, headers={
                "Content-Security-Policy": "sandbox",
                "X-Content-Type-Options": "nosniff",
            })
        except Exception as exc:
            return self._api_error(exc, "Raw fetch failed")

    async def _handle_exists(self, volume_key: str, request: Request, path: str | None = None):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        path_err = self._check_path(path)
        if path_err:
            return path_err
        try:
            result = await self.execute(
                lambda: connector.exists(client, path),
                cache_key=[f"files:{volume_key}:exists", path],
            )
            return {"exists": result}
        except Exception as exc:
            return self._api_error(exc, "Exists check failed")

    async def _handle_metadata(self, volume_key: str, request: Request, path: str | None = None):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        path_err = self._check_path(path)
        if path_err:
            return path_err
        try:
            return await self.execute(
                lambda: connector.metadata(client, path),
                cache_key=[f"files:{volume_key}:metadata", path],
            )
        except Exception as exc:
            return self._api_error(exc, "Metadata fetch failed")

    async def _handle_preview(self, volume_key: str, request: Request, path: str | None = None):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        path_err = self._check_path(path)
        if path_err:
            return path_err
        try:
            return await self.execute(
                lambda: connector.preview(client, path),
                cache_key=[f"files:{volume_key}:preview", path],
            )
        except Exception as exc:
            return self._api_error(exc, "Preview failed")

    async def _handle_upload(self, volume_key: str, request: Request, path: str | None = None):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        path_err = self._check_path(path)
        if path_err:
            return path_err

        # Content-Length pre-check
        cl = request.headers.get("content-length")
        if cl:
            try:
                if int(cl) > self._max_upload_size:
                    return JSONResponse({
                        "error": f"File size ({cl} bytes) exceeds maximum allowed size ({self._max_upload_size} bytes).",
                        "plugin": self.name,
                    }, status_code=413)
            except ValueError:
                pass

        try:
            # Stream body with size enforcement
            chunks: list[bytes] = []
            received = 0
            async for chunk in request.stream():
                received += len(chunk)
                if received > self._max_upload_size:
                    return JSONResponse({
                        "error": f"Upload stream exceeds maximum allowed size ({self._max_upload_size} bytes).",
                        "plugin": self.name,
                    }, status_code=413)
                chunks.append(chunk)
            body = b"".join(chunks)

            await self.execute(
                lambda: connector.upload(client, path, body),
                cache_enabled=False, retry_attempts=1, timeout=120.0,
            )
            return {"success": True}
        except Exception as exc:
            if "exceeds maximum" in str(exc):
                return JSONResponse({"error": str(exc), "plugin": self.name}, status_code=413)
            return self._api_error(exc, "Upload failed")

    async def _handle_mkdir(self, volume_key: str, request: Request):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass
        dir_path = body.get("path") if isinstance(body, dict) else None
        path_err = self._check_path(dir_path)
        if path_err:
            return path_err
        try:
            await self.execute(
                lambda: connector.create_directory(client, dir_path),
                cache_enabled=False, retry_attempts=1, timeout=120.0,
            )
            return {"success": True}
        except Exception as exc:
            return self._api_error(exc, "Create directory failed")

    async def _handle_delete(self, volume_key: str, request: Request, path: str | None = None):
        connector, client, err = self._resolve(volume_key, request)
        if err:
            return err
        path_err = self._check_path(path)
        if path_err:
            return path_err
        try:
            await self.execute(
                lambda: connector.delete(client, path),
                cache_enabled=False, retry_attempts=1, timeout=120.0,
            )
            return {"success": True}
        except Exception as exc:
            return self._api_error(exc, "Delete failed")

    def exports(self) -> dict[str, Any]:
        return {"volume": lambda key: self._connectors.get(key)}

    def client_config(self) -> dict[str, Any]:
        return {"volumes": list(self._volumes.keys())}


files = to_plugin(FilesPlugin)
