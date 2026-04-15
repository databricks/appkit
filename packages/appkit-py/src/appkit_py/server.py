"""Main FastAPI application — the Python AppKit backend server.

This is the full server implementation that provides 100% API compatibility
with the TypeScript AppKit backend. It serves the same endpoints that the
React frontend (appkit-ui) expects.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.staticfiles import StaticFiles

from appkit_py.connectors.files.client import FilesConnector
from appkit_py.connectors.genie.client import GenieConnector
from appkit_py.connectors.sql_warehouse.client import SQLWarehouseConnector
from appkit_py.plugins.analytics.query import QueryProcessor
from appkit_py.stream.sse_writer import SSE_HEADERS, format_error, format_event, format_heartbeat
from appkit_py.stream.stream_manager import StreamManager
from appkit_py.stream.types import SSEErrorCode

logger = logging.getLogger("appkit.server")


def _get_workspace_client() -> Any | None:
    """Create a WorkspaceClient if DATABRICKS_HOST is set."""
    host = os.environ.get("DATABRICKS_HOST")
    if not host:
        return None
    try:
        from databricks.sdk import WorkspaceClient
        return WorkspaceClient()
    except Exception as exc:
        logger.warning("Failed to create WorkspaceClient: %s", exc)
        return None


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_server(
    *,
    query_dir: str | None = None,
    static_path: str | None = None,
    genie_spaces: dict[str, str] | None = None,
    volumes: dict[str, str] | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application.

    This mirrors the TypeScript createApp() + server plugin pattern.
    """
    app = FastAPI(title="AppKit Python Backend")
    stream_manager = StreamManager()
    query_processor = QueryProcessor()

    # Discover configuration from environment
    _genie_spaces = genie_spaces or _discover_genie_spaces()
    _volumes = volumes or _discover_volumes()
    _query_dir = query_dir or _find_query_dir()

    # Initialize connectors
    _ws_client = _get_workspace_client()
    _sql_connector = SQLWarehouseConnector()
    _genie_connector = GenieConnector()
    _file_connectors: dict[str, FilesConnector] = {
        key: FilesConnector(default_volume=path) for key, path in _volumes.items()
    }
    _warehouse_id = os.environ.get("DATABRICKS_WAREHOUSE_ID")

    # -----------------------------------------------------------------------
    # Health endpoint
    # -----------------------------------------------------------------------
    @app.get("/health")
    async def health():
        return {"status": "ok"}

    # -----------------------------------------------------------------------
    # Reconnect plugin (test/dev SSE endpoint matching TS dev-playground)
    # -----------------------------------------------------------------------
    @app.get("/api/reconnect/stream")
    async def reconnect_stream(request: Request):
        async def event_generator() -> AsyncGenerator[str, None]:
            for i in range(1, 6):
                event_id = str(uuid.uuid4())
                yield format_event(event_id, {
                    "type": "message",
                    "count": i,
                    "total": 5,
                    "message": f"Event {i} of 5",
                })
                await asyncio.sleep(0.1)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={k: v for k, v in SSE_HEADERS.items() if k != "Content-Type"},
        )

    # -----------------------------------------------------------------------
    # Analytics plugin: POST /api/analytics/query/{query_key}
    # -----------------------------------------------------------------------
    @app.post("/api/analytics/query/{query_key}")
    async def analytics_query(query_key: str, request: Request):
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass

        format_ = body.get("format", "ARROW_STREAM")
        parameters = body.get("parameters")

        if not query_key:
            return JSONResponse({"error": "query_key is required"}, status_code=400)

        # Look up the query file
        query_text = _load_query(query_key, _query_dir)
        if query_text is None:
            return JSONResponse({"error": "Query not found"}, status_code=404)

        is_obo = query_key.endswith(".obo") or _has_obo_file(query_key, _query_dir)

        async def event_generator() -> AsyncGenerator[str, None]:
            if not _ws_client or not _warehouse_id:
                error_id = str(uuid.uuid4())
                yield format_error(
                    error_id,
                    "Databricks connection not configured",
                    SSEErrorCode.TEMPORARY_UNAVAILABLE,
                )
                return

            try:
                converted = query_processor.convert_to_sql_parameters(query_text, parameters)
                response = await _sql_connector.execute_statement(
                    _ws_client,
                    statement=converted["statement"],
                    warehouse_id=_warehouse_id,
                    parameters=converted.get("parameters") or None,
                    disposition="INLINE",
                    format={"ARROW_STREAM": "ARROW_STREAM", "JSON": "JSON_ARRAY", "ARROW": "ARROW_STREAM"}.get(format_, "JSON_ARRAY"),
                )

                # Transform result
                result_data: list[dict] = []
                if response.result and response.result.data_array:
                    columns = []
                    if response.manifest and response.manifest.schema and response.manifest.schema.columns:
                        columns = [c.name for c in response.manifest.schema.columns]
                    for row in response.result.data_array:
                        if columns:
                            result_data.append(dict(zip(columns, row)))
                        else:
                            result_data.append({"values": row})

                event_id = str(uuid.uuid4())
                yield format_event(event_id, {
                    "type": "result",
                    "chunk_index": 0,
                    "row_offset": 0,
                    "row_count": len(result_data),
                    "data": result_data,
                })

            except Exception as exc:
                error_id = str(uuid.uuid4())
                yield format_error(error_id, str(exc))

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={k: v for k, v in SSE_HEADERS.items() if k != "Content-Type"},
        )

    # -----------------------------------------------------------------------
    # Analytics plugin: GET /api/analytics/arrow-result/{job_id}
    # -----------------------------------------------------------------------
    @app.get("/api/analytics/arrow-result/{job_id}")
    async def analytics_arrow_result(job_id: str):
        if not _ws_client:
            return JSONResponse(
                {"error": "Arrow job not found", "plugin": "analytics"},
                status_code=404,
            )
        try:
            result = await _sql_connector.get_arrow_data(_ws_client, job_id)
            return Response(
                content=result["data"],
                media_type="application/octet-stream",
                headers={
                    "Content-Length": str(len(result["data"])),
                    "Cache-Control": "public, max-age=3600",
                },
            )
        except Exception as exc:
            return JSONResponse(
                {"error": str(exc) or "Arrow job not found", "plugin": "analytics"},
                status_code=404,
            )

    # -----------------------------------------------------------------------
    # Files plugin: GET /api/files/volumes
    # -----------------------------------------------------------------------
    @app.get("/api/files/volumes")
    async def files_volumes():
        return {"volumes": list(_volumes.keys())}

    # -----------------------------------------------------------------------
    # Files plugin: volume routes
    # -----------------------------------------------------------------------
    def _resolve_volume(volume_key: str) -> str | None:
        return _volumes.get(volume_key)

    def _validate_path(path: str | None) -> str | True:
        if not path:
            return "path is required"
        if len(path) > 4096:
            return f"path exceeds maximum length of 4096 characters (got {len(path)})"
        if "\0" in path:
            return "path must not contain null bytes"
        return True

    async def _run_file_op(volume_key: str, op_name: str, op_coro):
        """Helper to run a file operation with error handling."""
        if not _ws_client:
            return JSONResponse(
                {"error": "Databricks connection not configured", "plugin": "files"},
                status_code=500,
            )
        connector = _file_connectors.get(volume_key)
        if not connector:
            return JSONResponse(
                {"error": "Volume connector not found", "plugin": "files"},
                status_code=500,
            )
        try:
            return await op_coro
        except Exception as exc:
            status = 500
            if hasattr(exc, "status_code"):
                status = exc.status_code
            return JSONResponse(
                {"error": str(exc), "plugin": "files"},
                status_code=status,
            )

    @app.get("/api/files/{volume_key}/list")
    async def files_list(volume_key: str, request: Request, path: str | None = None):
        if not _resolve_volume(volume_key):
            safe_key = "".join(c for c in volume_key if c.isalnum() or c in "_-")
            return JSONResponse(
                {"error": f'Unknown volume "{safe_key}"', "plugin": "files"},
                status_code=404,
            )
        connector = _file_connectors.get(volume_key)
        if not _ws_client or not connector:
            return JSONResponse(
                {"error": "Databricks connection not configured", "plugin": "files"},
                status_code=500,
            )
        try:
            result = await connector.list(_ws_client, path)
            return result
        except Exception as exc:
            return JSONResponse(
                {"error": str(exc), "plugin": "files"}, status_code=500
            )

    @app.get("/api/files/{volume_key}/read")
    async def files_read(volume_key: str, path: str | None = None):
        if not _resolve_volume(volume_key):
            safe_key = "".join(c for c in volume_key if c.isalnum() or c in "_-")
            return JSONResponse(
                {"error": f'Unknown volume "{safe_key}"', "plugin": "files"},
                status_code=404,
            )
        valid = _validate_path(path)
        if valid is not True:
            return JSONResponse({"error": valid, "plugin": "files"}, status_code=400)
        connector = _file_connectors.get(volume_key)
        if not _ws_client or not connector:
            return JSONResponse(
                {"error": "Databricks connection not configured", "plugin": "files"},
                status_code=500,
            )
        try:
            text = await connector.read(_ws_client, path)
            return Response(content=text, media_type="text/plain")
        except Exception as exc:
            return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=500)

    def _file_handler_preamble(volume_key: str, path: str | None = None, require_path: bool = True):
        """Common preamble for file endpoints: resolve volume, validate path."""
        if not _resolve_volume(volume_key):
            safe_key = "".join(c for c in volume_key if c.isalnum() or c in "_-")
            return JSONResponse(
                {"error": f'Unknown volume "{safe_key}"', "plugin": "files"},
                status_code=404,
            )
        if require_path:
            valid = _validate_path(path)
            if valid is not True:
                return JSONResponse({"error": valid, "plugin": "files"}, status_code=400)
        connector = _file_connectors.get(volume_key)
        if not _ws_client or not connector:
            return JSONResponse(
                {"error": "Databricks connection not configured", "plugin": "files"},
                status_code=500,
            )
        return None  # All checks passed

    @app.get("/api/files/{volume_key}/download")
    async def files_download(volume_key: str, path: str | None = None):
        err = _file_handler_preamble(volume_key, path)
        if err:
            return err
        connector = _file_connectors[volume_key]
        try:
            result = await connector.download(_ws_client, path)
            import mimetypes
            content_type = result.get("content_type") or mimetypes.guess_type(path)[0] or "application/octet-stream"
            raw_name = path.split("/")[-1] if path else "download"
            # Sanitize filename: strip chars that could enable header injection
            filename = "".join(c for c in raw_name if c.isalnum() or c in "._- ")[:255] or "download"
            headers = {
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Content-Type-Options": "nosniff",
            }
            content = result.get("contents")
            if hasattr(content, "read"):
                body = content.read()
            else:
                body = content or b""
            return Response(content=body, media_type=content_type, headers=headers)
        except Exception as exc:
            return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=500)

    @app.get("/api/files/{volume_key}/raw")
    async def files_raw(volume_key: str, path: str | None = None):
        err = _file_handler_preamble(volume_key, path)
        if err:
            return err
        connector = _file_connectors[volume_key]
        try:
            result = await connector.download(_ws_client, path)
            import mimetypes
            content_type = result.get("content_type") or mimetypes.guess_type(path)[0] or "application/octet-stream"
            headers = {
                "Content-Security-Policy": "sandbox",
                "X-Content-Type-Options": "nosniff",
            }
            content = result.get("contents")
            if hasattr(content, "read"):
                body = content.read()
            else:
                body = content or b""
            return Response(content=body, media_type=content_type, headers=headers)
        except Exception as exc:
            return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=500)

    @app.get("/api/files/{volume_key}/exists")
    async def files_exists(volume_key: str, path: str | None = None):
        err = _file_handler_preamble(volume_key, path)
        if err:
            return err
        connector = _file_connectors[volume_key]
        try:
            exists = await connector.exists(_ws_client, path)
            return {"exists": exists}
        except Exception as exc:
            return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=500)

    @app.get("/api/files/{volume_key}/metadata")
    async def files_metadata(volume_key: str, path: str | None = None):
        err = _file_handler_preamble(volume_key, path)
        if err:
            return err
        connector = _file_connectors[volume_key]
        try:
            meta = await connector.metadata(_ws_client, path)
            return meta
        except Exception as exc:
            return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=500)

    @app.get("/api/files/{volume_key}/preview")
    async def files_preview(volume_key: str, path: str | None = None):
        err = _file_handler_preamble(volume_key, path)
        if err:
            return err
        connector = _file_connectors[volume_key]
        try:
            preview = await connector.preview(_ws_client, path)
            return preview
        except Exception as exc:
            return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=500)

    @app.post("/api/files/{volume_key}/upload")
    async def files_upload(volume_key: str, request: Request, path: str | None = None):
        if not _resolve_volume(volume_key):
            safe_key = "".join(c for c in volume_key if c.isalnum() or c in "_-")
            return JSONResponse(
                {"error": f'Unknown volume "{safe_key}"', "plugin": "files"},
                status_code=404,
            )
        valid = _validate_path(path)
        if valid is not True:
            return JSONResponse({"error": valid, "plugin": "files"}, status_code=400)

        max_size = 5 * 1024 * 1024 * 1024  # 5GB
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                size = int(content_length)
                if size > max_size:
                    return JSONResponse(
                        {
                            "error": f"File size ({size} bytes) exceeds maximum allowed size ({max_size} bytes).",
                            "plugin": "files",
                        },
                        status_code=413,
                    )
            except ValueError:
                pass

        connector = _file_connectors.get(volume_key)
        if not _ws_client or not connector:
            return JSONResponse(
                {"error": "Databricks connection not configured", "plugin": "files"},
                status_code=500,
            )
        try:
            # Stream the body with a running size counter to prevent OOM
            chunks: list[bytes] = []
            bytes_received = 0
            async for chunk in request.stream():
                bytes_received += len(chunk)
                if bytes_received > max_size:
                    return JSONResponse(
                        {
                            "error": f"Upload stream exceeds maximum allowed size ({max_size} bytes).",
                            "plugin": "files",
                        },
                        status_code=413,
                    )
                chunks.append(chunk)
            body = b"".join(chunks)
            await connector.upload(_ws_client, path, body)
            return {"success": True}
        except Exception as exc:
            if "exceeds maximum allowed size" in str(exc):
                return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=413)
            return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=500)

    @app.post("/api/files/{volume_key}/mkdir")
    async def files_mkdir(volume_key: str, request: Request):
        if not _resolve_volume(volume_key):
            safe_key = "".join(c for c in volume_key if c.isalnum() or c in "_-")
            return JSONResponse(
                {"error": f'Unknown volume "{safe_key}"', "plugin": "files"},
                status_code=404,
            )
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass
        dir_path = body.get("path") if isinstance(body, dict) else None
        valid = _validate_path(dir_path)
        if valid is not True:
            return JSONResponse({"error": valid, "plugin": "files"}, status_code=400)
        connector = _file_connectors.get(volume_key)
        if not _ws_client or not connector:
            return JSONResponse(
                {"error": "Databricks connection not configured", "plugin": "files"},
                status_code=500,
            )
        try:
            await connector.create_directory(_ws_client, dir_path)
            return {"success": True}
        except Exception as exc:
            return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=500)

    @app.delete("/api/files/{volume_key}")
    async def files_delete(volume_key: str, path: str | None = None):
        if not _resolve_volume(volume_key):
            safe_key = "".join(c for c in volume_key if c.isalnum() or c in "_-")
            return JSONResponse(
                {"error": f'Unknown volume "{safe_key}"', "plugin": "files"},
                status_code=404,
            )
        valid = _validate_path(path)
        if valid is not True:
            return JSONResponse({"error": valid, "plugin": "files"}, status_code=400)
        connector = _file_connectors.get(volume_key)
        if not _ws_client or not connector:
            return JSONResponse(
                {"error": "Databricks connection not configured", "plugin": "files"},
                status_code=500,
            )
        try:
            await connector.delete(_ws_client, path)
            return {"success": True}
        except Exception as exc:
            return JSONResponse({"error": str(exc), "plugin": "files"}, status_code=500)

    # -----------------------------------------------------------------------
    # Genie plugin
    # -----------------------------------------------------------------------
    def _sse_from_genie(gen_coro) -> StreamingResponse:
        """Create an SSE StreamingResponse from a genie async generator."""
        async def event_generator() -> AsyncGenerator[str, None]:
            if not _ws_client:
                error_id = str(uuid.uuid4())
                yield format_error(error_id, "Databricks Genie connection not configured", SSEErrorCode.TEMPORARY_UNAVAILABLE)
                return
            try:
                async for event in gen_coro:
                    event_id = str(uuid.uuid4())
                    yield format_event(event_id, event)
            except Exception as exc:
                error_id = str(uuid.uuid4())
                yield format_error(error_id, str(exc))

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={k: v for k, v in SSE_HEADERS.items() if k != "Content-Type"},
        )

    @app.post("/api/genie/{alias}/messages")
    async def genie_send_message(alias: str, request: Request):
        space_id = _genie_spaces.get(alias)
        if not space_id:
            return JSONResponse({"error": f"Unknown space alias: {alias}"}, status_code=404)

        body = {}
        try:
            body = await request.json()
        except Exception:
            pass
        content = body.get("content") if isinstance(body, dict) else None
        if not content:
            return JSONResponse({"error": "content is required"}, status_code=400)

        conversation_id = body.get("conversationId") if isinstance(body, dict) else None
        return _sse_from_genie(
            _genie_connector.stream_send_message(_ws_client, space_id, content, conversation_id)
        )

    @app.get("/api/genie/{alias}/conversations/{conversation_id}")
    async def genie_get_conversation(alias: str, conversation_id: str, request: Request):
        space_id = _genie_spaces.get(alias)
        if not space_id:
            return JSONResponse({"error": f"Unknown space alias: {alias}"}, status_code=404)

        include_query_results = request.query_params.get("includeQueryResults", "true") != "false"
        page_token = request.query_params.get("pageToken")
        return _sse_from_genie(
            _genie_connector.stream_conversation(
                _ws_client, space_id, conversation_id,
                include_query_results=include_query_results, page_token=page_token,
            )
        )

    @app.get("/api/genie/{alias}/conversations/{conversation_id}/messages/{message_id}")
    async def genie_get_message(alias: str, conversation_id: str, message_id: str, request: Request):
        space_id = _genie_spaces.get(alias)
        if not space_id:
            return JSONResponse({"error": f"Unknown space alias: {alias}"}, status_code=404)

        return _sse_from_genie(
            _genie_connector.stream_get_message(_ws_client, space_id, conversation_id, message_id)
        )

    # -----------------------------------------------------------------------
    # Static file serving with client config injection
    # -----------------------------------------------------------------------
    resolved_static = static_path or _find_static_dir()
    if resolved_static and Path(resolved_static).is_dir():
        _static_dir = Path(resolved_static)
        _index_html = _static_dir / "index.html"

        # Build client config (injected into index.html like TS StaticServer)
        _client_config = json.dumps({
            "appName": os.environ.get("DATABRICKS_APP_NAME", "appkit-py"),
            "queries": {},
            "endpoints": {
                "analytics": {"query": "/api/analytics/query", "arrow": "/api/analytics/arrow-result"},
                "files": {
                    "volumes": "/api/files/volumes", "list": "/api/files/:volumeKey/list",
                    "read": "/api/files/:volumeKey/read", "download": "/api/files/:volumeKey/download",
                    "raw": "/api/files/:volumeKey/raw", "exists": "/api/files/:volumeKey/exists",
                    "metadata": "/api/files/:volumeKey/metadata", "preview": "/api/files/:volumeKey/preview",
                    "upload": "/api/files/:volumeKey/upload", "mkdir": "/api/files/:volumeKey/mkdir",
                    "delete": "/api/files/:volumeKey",
                },
                "genie": {
                    "sendMessage": "/api/genie/:alias/messages",
                    "getConversation": "/api/genie/:alias/conversations/:conversationId",
                    "getMessage": "/api/genie/:alias/conversations/:conversationId/messages/:messageId",
                },
            },
            "plugins": {
                "files": {"volumes": list(_volumes.keys())},
                "genie": {"spaces": list(_genie_spaces.keys())},
            },
        })
        # Escape for safe HTML embedding
        _safe_config = _client_config.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")

        @app.get("/{full_path:path}")
        async def serve_spa(full_path: str):
            """Serve static files or index.html with injected config (SPA catch-all)."""
            import mimetypes
            # Resolve and verify the path stays within the static directory
            file_path = (_static_dir / full_path).resolve()
            static_root = _static_dir.resolve()
            if (
                file_path.is_file()
                and str(file_path).startswith(str(static_root) + os.sep)
            ):
                ct = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
                return Response(content=file_path.read_bytes(), media_type=ct)

            # Fall back to index.html with injected config
            if _index_html.is_file():
                html = _index_html.read_text()
                config_script = (
                    f'<script id="__appkit__" type="application/json">{_safe_config}</script>\n'
                    '<script>window.__appkit__=JSON.parse(document.getElementById("__appkit__")?.textContent||"{}")</script>'
                )
                # Inject before </head> or at end of <head>
                if "</head>" in html:
                    html = html.replace("</head>", f"{config_script}\n</head>")
                else:
                    html = config_script + "\n" + html
                return Response(content=html, media_type="text/html")

            return JSONResponse({"error": "Not found"}, status_code=404)

    return app


# ---------------------------------------------------------------------------
# Configuration discovery helpers
# ---------------------------------------------------------------------------

def _discover_genie_spaces() -> dict[str, str]:
    space_id = os.environ.get("DATABRICKS_GENIE_SPACE_ID")
    if space_id:
        return {"default": space_id}
    return {}


def _discover_volumes() -> dict[str, str]:
    prefix = "DATABRICKS_VOLUME_"
    volumes: dict[str, str] = {}
    for key, value in os.environ.items():
        if key.startswith(prefix) and value:
            suffix = key[len(prefix):]
            if suffix:
                volumes[suffix.lower()] = value
    return volumes


def _find_static_dir() -> str | None:
    """Auto-detect the frontend static directory (matching TS StaticServer logic)."""
    candidates = [
        "client/dist", "dist", "build", "public", "out",
        "../client/dist", "../dist",
    ]
    for candidate in candidates:
        if Path(candidate).is_dir():
            return candidate
    return None


def _find_query_dir() -> str | None:
    """Find the config/queries directory relative to CWD."""
    candidates = ["config/queries", "../config/queries", "../../config/queries"]
    for candidate in candidates:
        path = Path(candidate)
        if path.is_dir():
            return str(path)
    return None


def _load_query(query_key: str, query_dir: str | None) -> str | None:
    """Load a SQL query file by key from the query directory."""
    if not query_dir:
        return None

    # Sanitize query_key: reject path separators and traversal sequences
    if "/" in query_key or "\\" in query_key or ".." in query_key:
        return None

    base = query_key.removesuffix(".obo")
    dir_path = Path(query_dir).resolve()

    # Try .obo.sql first, then .sql
    for suffix in [".obo.sql", ".sql"]:
        file_path = (dir_path / f"{base}{suffix}").resolve()
        # Verify the resolved path stays within the query directory
        if not str(file_path).startswith(str(dir_path) + os.sep):
            return None
        if file_path.is_file():
            return file_path.read_text()

    return None


def _has_obo_file(query_key: str, query_dir: str | None) -> bool:
    """Check if a .obo.sql variant exists for this query key."""
    if not query_dir:
        return False
    base = query_key.removesuffix(".obo")
    return (Path(query_dir) / f"{base}.obo.sql").is_file()


# ---------------------------------------------------------------------------
# App instance for uvicorn
# ---------------------------------------------------------------------------

app = create_server()
