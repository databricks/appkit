"""Files connector wrapping databricks.sdk.

Mirrors packages/appkit/src/connectors/files/client.ts
"""

from __future__ import annotations

import asyncio
import io
import logging
import mimetypes
from typing import Any

from databricks.sdk import WorkspaceClient

logger = logging.getLogger("appkit.connector.files")

# Maximum path length (matching TS)
MAX_PATH_LENGTH = 4096


class FilesConnector:
    """Perform file operations on Unity Catalog Volumes via Databricks SDK."""

    def __init__(self, default_volume: str | None = None) -> None:
        self.default_volume = default_volume or ""

    def resolve_path(self, file_path: str) -> str:
        """Resolve a relative path against the default volume."""
        if file_path.startswith("/Volumes/"):
            return file_path
        # Strip leading slash and join with volume path
        clean = file_path.lstrip("/")
        return f"{self.default_volume.rstrip('/')}/{clean}"

    async def list(
        self, client: WorkspaceClient, directory_path: str | None = None
    ) -> list[dict[str, Any]]:
        """List directory contents."""
        path = self.resolve_path(directory_path or "")
        entries = await asyncio.to_thread(
            lambda: list(client.files.list_directory_contents(path))
        )
        return [
            {
                "name": e.name,
                "path": e.path,
                "is_directory": e.is_directory,
                "file_size": e.file_size,
                "last_modified": e.last_modified,
            }
            for e in entries
        ]

    async def read(
        self, client: WorkspaceClient, file_path: str, options: dict | None = None
    ) -> str:
        """Read file as text."""
        path = self.resolve_path(file_path)
        response = await asyncio.to_thread(client.files.download, path)
        content = response.contents.read()
        if isinstance(content, bytes):
            return content.decode("utf-8", errors="replace")
        return content

    async def download(
        self, client: WorkspaceClient, file_path: str
    ) -> dict[str, Any]:
        """Download file as binary stream."""
        path = self.resolve_path(file_path)
        response = await asyncio.to_thread(client.files.download, path)
        return {"contents": response.contents, "content_type": response.content_type}

    async def exists(self, client: WorkspaceClient, file_path: str) -> bool:
        """Check if a file exists."""
        path = self.resolve_path(file_path)
        try:
            await asyncio.to_thread(client.files.get_metadata, path)
            return True
        except Exception:
            return False

    async def metadata(
        self, client: WorkspaceClient, file_path: str
    ) -> dict[str, Any]:
        """Get file metadata."""
        path = self.resolve_path(file_path)
        meta = await asyncio.to_thread(client.files.get_metadata, path)
        return {
            "contentLength": meta.content_length,
            "contentType": meta.content_type,
            "lastModified": str(meta.last_modified) if meta.last_modified else None,
        }

    async def upload(
        self,
        client: WorkspaceClient,
        file_path: str,
        contents: bytes | io.IOBase,
        options: dict | None = None,
    ) -> None:
        """Upload file contents."""
        path = self.resolve_path(file_path)
        overwrite = (options or {}).get("overwrite", True)
        if isinstance(contents, bytes):
            contents = io.BytesIO(contents)
        await asyncio.to_thread(
            client.files.upload, path, contents, overwrite=overwrite
        )

    async def create_directory(
        self, client: WorkspaceClient, directory_path: str
    ) -> None:
        """Create a directory."""
        path = self.resolve_path(directory_path)
        await asyncio.to_thread(client.files.create_directory, path)

    async def delete(self, client: WorkspaceClient, file_path: str) -> None:
        """Delete a file."""
        path = self.resolve_path(file_path)
        await asyncio.to_thread(client.files.delete, path)

    async def preview(
        self, client: WorkspaceClient, file_path: str
    ) -> dict[str, Any]:
        """Get a preview of a file (metadata + text preview for text files)."""
        path = self.resolve_path(file_path)
        meta = await asyncio.to_thread(client.files.get_metadata, path)
        content_type = meta.content_type or mimetypes.guess_type(file_path)[0] or ""
        is_text = content_type.startswith("text/") or content_type in (
            "application/json", "application/xml", "application/javascript",
        )
        is_image = content_type.startswith("image/")

        text_preview = None
        if is_text:
            try:
                response = await asyncio.to_thread(client.files.download, path)
                raw = response.contents.read(1024)
                text_preview = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
            except Exception:
                pass

        return {
            "contentLength": meta.content_length,
            "contentType": meta.content_type,
            "lastModified": str(meta.last_modified) if meta.last_modified else None,
            "textPreview": text_preview,
            "isText": is_text,
            "isImage": is_image,
        }
