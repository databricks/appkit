"""Genie plugin for AI/BI natural language queries.

Mirrors packages/appkit/src/plugins/genie/genie.ts
"""

from __future__ import annotations

import logging
import os
from typing import Any, AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from appkit_py.connectors.genie.client import GenieConnector
from appkit_py.plugin.plugin import Plugin, to_plugin

logger = logging.getLogger("appkit.genie")


class GeniePlugin(Plugin):
    name = "genie"
    phase = "normal"

    default_timeout = 120.0
    default_retry_attempts = 1
    default_cache_ttl = 0  # Genie conversations are stateful, not cacheable

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self._spaces = self.config.get("spaces") or self._default_spaces()
        self._connector = GenieConnector(
            timeout=self.config.get("timeout", 120.0),
            max_messages=200,
        )

    @staticmethod
    def _default_spaces() -> dict[str, str]:
        space_id = os.environ.get("DATABRICKS_GENIE_SPACE_ID")
        return {"default": space_id} if space_id else {}

    def _resolve_space(self, alias: str) -> str | None:
        return self._spaces.get(alias)

    def inject_routes(self, router: APIRouter) -> None:
        self.route(router, name="sendMessage", method="post", path="/{alias}/messages",
                   handler=self._handle_send_message)
        self.route(router, name="getConversation", method="get",
                   path="/{alias}/conversations/{conversation_id}",
                   handler=self._handle_get_conversation)
        self.route(router, name="getMessage", method="get",
                   path="/{alias}/conversations/{conversation_id}/messages/{message_id}",
                   handler=self._handle_get_message)

    async def _handle_send_message(self, alias: str, request: Request):
        space_id = self._resolve_space(alias)
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
        client = self.get_workspace_client(request)

        async def handler(signal=None):
            if not client:
                yield {"type": "error", "error": "Databricks Genie connection not configured"}
                return
            async for event in self._connector.stream_send_message(
                client, space_id, content, conversation_id, signal=signal
            ):
                yield event

        return await self.execute_stream(request, handler)

    async def _handle_get_conversation(self, alias: str, conversation_id: str, request: Request):
        space_id = self._resolve_space(alias)
        if not space_id:
            return JSONResponse({"error": f"Unknown space alias: {alias}"}, status_code=404)

        include_query_results = request.query_params.get("includeQueryResults", "true") != "false"
        page_token = request.query_params.get("pageToken")
        client = self.get_workspace_client(request)

        async def handler(signal=None):
            if not client:
                yield {"type": "error", "error": "Databricks Genie connection not configured"}
                return
            async for event in self._connector.stream_conversation(
                client, space_id, conversation_id,
                include_query_results=include_query_results, page_token=page_token, signal=signal,
            ):
                yield event

        return await self.execute_stream(request, handler)

    async def _handle_get_message(self, alias: str, conversation_id: str, message_id: str, request: Request):
        space_id = self._resolve_space(alias)
        if not space_id:
            return JSONResponse({"error": f"Unknown space alias: {alias}"}, status_code=404)

        client = self.get_workspace_client(request)

        async def handler(signal=None):
            if not client:
                yield {"type": "error", "error": "Databricks Genie connection not configured"}
                return
            async for event in self._connector.stream_get_message(
                client, space_id, conversation_id, message_id, signal=signal,
            ):
                yield event

        return await self.execute_stream(request, handler)

    async def send_message(self, alias: str, content: str, conversation_id: str | None = None):
        """Programmatic API matching TS exports().sendMessage."""
        space_id = self._resolve_space(alias)
        if not space_id:
            raise ValueError(f"Unknown space alias: {alias}")
        client = self.get_workspace_client()
        async for event in self._connector.stream_send_message(client, space_id, content, conversation_id):
            yield event

    def exports(self) -> dict[str, Any]:
        return {"sendMessage": self.send_message}

    def client_config(self) -> dict[str, Any]:
        return {"spaces": list(self._spaces.keys())}


genie = to_plugin(GeniePlugin)
