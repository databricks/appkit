"""Genie connector wrapping databricks.sdk.

Mirrors packages/appkit/src/connectors/genie/client.ts
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncGenerator

from databricks.sdk import WorkspaceClient

logger = logging.getLogger("appkit.connector.genie")


class GenieConnector:
    """Interact with Databricks AI/BI Genie via the SDK."""

    def __init__(self, timeout: float = 120.0, max_messages: int = 200) -> None:
        self.timeout = timeout
        self.max_messages = max_messages

    async def stream_send_message(
        self,
        client: WorkspaceClient,
        space_id: str,
        content: str,
        conversation_id: str | None = None,
        *,
        timeout: float | None = None,
        signal: asyncio.Event | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Send a message and stream events."""
        if conversation_id:
            # Existing conversation
            waiter = await asyncio.to_thread(
                client.genie.create_message, space_id, conversation_id, content
            )
        else:
            # New conversation
            waiter = await asyncio.to_thread(
                client.genie.start_conversation, space_id, content
            )

        # Yield message_start
        msg_id = getattr(waiter, "message_id", None) or "pending"
        conv_id = conversation_id or getattr(waiter, "conversation_id", None) or "new"
        yield {
            "type": "message_start",
            "conversationId": conv_id,
            "messageId": msg_id,
            "spaceId": space_id,
        }

        # Yield status
        yield {"type": "status", "status": "EXECUTING"}

        # Wait for completion
        try:
            result = await asyncio.to_thread(
                waiter.result, timeout=self.timeout
            )

            conv_id = result.conversation_id or conv_id
            msg_id = result.id or msg_id

            # Build message response
            message_response = {
                "messageId": msg_id,
                "conversationId": conv_id,
                "spaceId": space_id,
                "status": result.status.value if result.status else "COMPLETED",
                "content": result.content or "",
                "attachments": [],
            }

            if result.attachments:
                for att in result.attachments:
                    att_data: dict[str, Any] = {}
                    if att.query:
                        att_data["query"] = {
                            "title": getattr(att.query, "title", None),
                            "description": getattr(att.query, "description", None),
                            "query": getattr(att.query, "query", None),
                        }
                    if att.text:
                        att_data["text"] = {"content": getattr(att.text, "content", None)}
                    message_response["attachments"].append(att_data)

            yield {"type": "message_result", "message": message_response}

            # Fetch query results for attachments
            if result.attachments:
                for att in result.attachments:
                    if att.query and hasattr(att, "id") and att.id:
                        try:
                            query_result = await asyncio.to_thread(
                                client.genie.execute_message_attachment_query,
                                space_id, conv_id, msg_id, att.id,
                            )
                            yield {
                                "type": "query_result",
                                "attachmentId": att.id,
                                "statementId": getattr(query_result, "statement_id", ""),
                                "data": _serialize_query_result(query_result),
                            }
                        except Exception as exc:
                            logger.warning("Failed to fetch query result: %s", exc)

        except Exception as exc:
            yield {"type": "error", "error": str(exc)}

    async def stream_conversation(
        self,
        client: WorkspaceClient,
        space_id: str,
        conversation_id: str,
        *,
        include_query_results: bool = True,
        page_token: str | None = None,
        signal: asyncio.Event | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Stream conversation history."""
        try:
            result = await asyncio.to_thread(
                client.genie.list_conversation_messages,
                space_id, conversation_id,
                page_token=page_token,
                page_size=self.max_messages,
            )

            messages = result.messages or []
            for msg in messages:
                yield {
                    "type": "message_result",
                    "message": {
                        "messageId": msg.id,
                        "conversationId": conversation_id,
                        "spaceId": space_id,
                        "status": msg.status.value if msg.status else "COMPLETED",
                        "content": msg.content or "",
                        "attachments": [],
                    },
                }

            yield {
                "type": "history_info",
                "conversationId": conversation_id,
                "spaceId": space_id,
                "nextPageToken": result.next_page_token,
                "loadedCount": len(messages),
            }

        except Exception as exc:
            yield {"type": "error", "error": str(exc)}

    async def stream_get_message(
        self,
        client: WorkspaceClient,
        space_id: str,
        conversation_id: str,
        message_id: str,
        *,
        timeout: float | None = None,
        signal: asyncio.Event | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Stream a single message (poll until complete)."""
        try:
            result = await asyncio.to_thread(
                client.genie.get_message,
                space_id, conversation_id, message_id,
            )

            yield {
                "type": "message_result",
                "message": {
                    "messageId": result.id,
                    "conversationId": conversation_id,
                    "spaceId": space_id,
                    "status": result.status.value if result.status else "COMPLETED",
                    "content": result.content or "",
                    "attachments": [],
                },
            }

        except Exception as exc:
            yield {"type": "error", "error": str(exc)}

    async def get_conversation(
        self,
        client: WorkspaceClient,
        space_id: str,
        conversation_id: str,
    ) -> dict[str, Any]:
        """Get full conversation (non-streaming)."""
        result = await asyncio.to_thread(
            client.genie.list_conversation_messages,
            space_id, conversation_id,
        )
        return {
            "messages": [
                {
                    "messageId": msg.id,
                    "conversationId": conversation_id,
                    "spaceId": space_id,
                    "status": msg.status.value if msg.status else "COMPLETED",
                    "content": msg.content or "",
                }
                for msg in (result.messages or [])
            ],
            "nextPageToken": result.next_page_token,
        }


def _serialize_query_result(result: Any) -> dict[str, Any]:
    """Serialize a GenieGetMessageQueryResultResponse to match TS format."""
    columns = []
    data_array = []
    if hasattr(result, "columns") and result.columns:
        columns = [{"name": c.name, "type_name": c.type_name} for c in result.columns]
    if hasattr(result, "statement_response") and result.statement_response:
        sr = result.statement_response
        if sr.manifest and sr.manifest.schema and sr.manifest.schema.columns:
            columns = [
                {"name": c.name, "type_name": c.type_name}
                for c in sr.manifest.schema.columns
            ]
        if sr.result and sr.result.data_array:
            data_array = sr.result.data_array
    return {
        "manifest": {"schema": {"columns": columns}},
        "result": {"data_array": data_array},
    }
