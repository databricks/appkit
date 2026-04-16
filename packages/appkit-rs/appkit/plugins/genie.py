"""GeniePlugin — conversational analytics over Databricks Genie spaces.

Exposes routes under ``/api/genie``:

- ``POST /message`` — send a message (start a new conversation or reply
  to an existing one) and wait for the completed response.
- ``GET /conversation?space=<alias>&conversation_id=<id>`` — read the
  full conversation history.
- ``GET /query-result?...`` — fetch the tabular result for an attachment.

Auth is always OBO — Genie spaces are user-scoped. The Rust
``GenieConnector`` handles polling, retries, and response shaping.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qs

from appkit import GenieConnector, Plugin, PluginManifest, ValidationError

from ._obo import obo_token, obo_user_key


class GeniePluginConfig:
    """Configuration for :class:`GeniePlugin`.

    ``spaces`` maps alias → Genie ``space_id``. Route handlers accept
    an alias (not the raw space id) so the client never sees the UC
    resource identifier.
    """

    __slots__ = ("spaces", "host", "timeout_ms", "max_messages")

    def __init__(
        self,
        *,
        spaces: Mapping[str, str],
        host: str | None = None,
        timeout_ms: int | None = None,
        max_messages: int | None = None,
    ) -> None:
        if not spaces:
            raise ValueError("GeniePluginConfig requires at least one space")
        self.spaces: dict[str, str] = dict(spaces)
        self.host = host
        self.timeout_ms = timeout_ms
        self.max_messages = max_messages

    def __repr__(self) -> str:
        return f"GeniePluginConfig(spaces={sorted(self.spaces)!r})"


def _query(request: Any) -> dict[str, str]:
    parsed = parse_qs(request.query, keep_blank_values=True)
    return {k: v[0] for k, v in parsed.items() if v}


class GeniePlugin(Plugin):
    """Genie conversational analytics plugin."""

    NAME = "genie"

    def __init__(self, config: GeniePluginConfig) -> None:
        super().__init__(
            self.NAME,
            manifest=PluginManifest(
                self.NAME,
                display_name="Genie Plugin",
                description="Databricks Genie conversational analytics",
            ),
        )
        host = config.host or os.environ.get("DATABRICKS_HOST")
        if not host:
            raise ValueError(
                "GeniePlugin requires a Databricks host. Set DATABRICKS_HOST "
                "or pass host= in GeniePluginConfig."
            )
        self._config = config
        self._host = host
        self._connector = GenieConnector(
            host,
            timeout_ms=config.timeout_ms,
            max_messages=config.max_messages,
        )

    def client_config(self) -> dict[str, str]:
        return {"spaces": ",".join(sorted(self._config.spaces))}

    def inject_routes(self, router: Any) -> None:
        router.post("/message", self._handle_message)
        router.get("/conversation", self._handle_conversation)
        router.get("/query-result", self._handle_query_result)

    def _resolve_space(self, alias: str) -> str:
        try:
            return self._config.spaces[alias]
        except KeyError as exc:
            raise ValidationError(
                f"Unknown space alias {alias!r}. Configured: "
                f"{sorted(self._config.spaces)!r}"
            ) from exc

    async def _handle_message(self, request: Any) -> str:
        token = obo_token(request.headers)
        body = request.json() if request.body else {}
        if not isinstance(body, dict):
            raise ValidationError("Request body must be a JSON object")
        alias = body.get("space")
        content = body.get("content")
        if not alias or not content:
            raise ValidationError("'space' and 'content' are required")
        conversation_id = body.get("conversation_id")
        space_id = self._resolve_space(alias)

        msg = await self._connector.send_message(
            token,
            space_id,
            content,
            conversation_id=conversation_id,
        )
        return _message_to_json(msg)

    async def _handle_conversation(self, request: Any) -> str:
        token = obo_token(request.headers)
        params = _query(request)
        alias = params.get("space")
        conv_id = params.get("conversation_id")
        if not alias or not conv_id:
            raise ValidationError(
                "'space' and 'conversation_id' are required query parameters"
            )
        space_id = self._resolve_space(alias)
        history = await self._connector.get_conversation(token, space_id, conv_id)
        return json.dumps(
            {
                "conversation_id": history.conversation_id,
                "space_id": history.space_id,
                "messages": [
                    json.loads(_message_to_json(m)) for m in history.messages
                ],
            }
        )

    async def _handle_query_result(self, request: Any) -> str:
        token = obo_token(request.headers)
        params = _query(request)
        alias = params.get("space")
        conv_id = params.get("conversation_id")
        msg_id = params.get("message_id")
        att_id = params.get("attachment_id")
        if not (alias and conv_id and msg_id and att_id):
            raise ValidationError(
                "'space', 'conversation_id', 'message_id', and 'attachment_id' "
                "are required query parameters"
            )
        space_id = self._resolve_space(alias)
        result = await self._connector.get_query_result(
            token, space_id, conv_id, msg_id, att_id
        )
        # GenieQueryResult.data is already a JSON string; pass it through
        # inside a stable envelope so clients always parse an object.
        return json.dumps({"data": json.loads(result.data) if result.data else None})

    def _user_key(self, request: Any) -> str:
        return obo_user_key(request.headers)


def _message_to_json(msg: Any) -> str:
    attachments = []
    for att in msg.attachments:
        attachments.append(
            {
                "attachment_id": att.attachment_id,
                "query_title": att.query_title,
                "query_description": att.query_description,
                "query_sql": att.query_sql,
                "query_statement_id": att.query_statement_id,
                "text_content": att.text_content,
                "suggested_questions": att.suggested_questions,
            }
        )
    return json.dumps(
        {
            "message_id": msg.message_id,
            "conversation_id": msg.conversation_id,
            "space_id": msg.space_id,
            "status": msg.status,
            "content": msg.content,
            "attachments": attachments,
            "error": msg.error,
        }
    )


__all__ = ["GeniePlugin", "GeniePluginConfig"]
