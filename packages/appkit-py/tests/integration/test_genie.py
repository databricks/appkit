"""Integration tests for the Genie plugin API.

Endpoints:
    POST /api/genie/:alias/messages                                    → SSE stream
    GET  /api/genie/:alias/conversations/:conversationId               → SSE stream
    GET  /api/genie/:alias/conversations/:conversationId/messages/:mid → SSE stream
"""

from __future__ import annotations

import httpx
import pytest

from tests.helpers.sse_parser import collect_sse_stream, events_only

pytestmark = pytest.mark.integration


class TestGenieSendMessage:
    """Tests for POST /api/genie/:alias/messages."""

    async def test_unknown_alias_returns_404(self, http_client: httpx.AsyncClient):
        """Sending a message to an unknown space alias should return 404."""
        response = await http_client.post(
            "/api/genie/nonexistent_alias_xyz/messages",
            json={"content": "Hello"},
        )
        assert response.status_code == 404
        body = response.json()
        assert "error" in body

    async def test_missing_content_returns_400(self, http_client: httpx.AsyncClient):
        """Sending a message without content should return 400."""
        response = await http_client.post(
            "/api/genie/demo/messages",
            json={},  # No content field
        )
        # 400 (missing content) or 404 (unknown alias) are both valid
        assert response.status_code in (400, 404)

    async def test_send_message_returns_sse(self, http_client: httpx.AsyncClient):
        """If demo space is configured, sending a message should return SSE."""
        try:
            async with http_client.stream(
                "POST",
                "/api/genie/demo/messages",
                json={"content": "What are the top products?"},
                timeout=30.0,
            ) as resp:
                if resp.status_code == 404:
                    pytest.skip("Genie 'demo' space not configured")
                content_type = resp.headers.get("content-type", "")
                assert "text/event-stream" in content_type
        except (httpx.HTTPError, httpx.StreamError):
            pytest.skip("Genie endpoint not available")

    async def test_send_message_events_include_message_start(
        self, http_client: httpx.AsyncClient
    ):
        """Genie stream should start with a message_start event."""
        try:
            events = await collect_sse_stream(
                http_client,
                "POST",
                "/api/genie/demo/messages",
                json_body={"content": "Hello"},
                timeout=30.0,
                max_events=10,
            )
        except (httpx.HTTPError, httpx.StreamError):
            pytest.skip("Genie endpoint not available")

        real = events_only(events)
        if not real:
            pytest.skip("No genie events received")

        # First non-error event should be message_start
        first_event = real[0]
        if first_event.is_error:
            pytest.skip("Got error instead of message_start — Genie may not be configured")

        data = first_event.parsed_data
        assert data is not None
        assert data.get("type") == "message_start"
        assert "conversationId" in data
        assert "messageId" in data
        assert "spaceId" in data

    async def test_send_message_with_request_id(self, http_client: httpx.AsyncClient):
        """Messages with a custom requestId query param should work."""
        response = await http_client.post(
            "/api/genie/demo/messages",
            params={"requestId": "custom-request-id-123"},
            json={"content": "Hello"},
        )
        # Either SSE stream or 404 (alias not found)
        assert response.status_code in (200, 404)


class TestGenieGetConversation:
    """Tests for GET /api/genie/:alias/conversations/:conversationId."""

    async def test_unknown_alias_returns_404(self, http_client: httpx.AsyncClient):
        response = await http_client.get(
            "/api/genie/nonexistent_alias/conversations/conv-123"
        )
        assert response.status_code == 404

    async def test_get_conversation_returns_sse_or_error(
        self, http_client: httpx.AsyncClient
    ):
        """Getting a conversation should return SSE or a structured error."""
        try:
            async with http_client.stream(
                "GET",
                "/api/genie/demo/conversations/fake-conv-id",
                timeout=15.0,
            ) as resp:
                if resp.status_code == 404:
                    pytest.skip("Genie 'demo' space not configured")
                content_type = resp.headers.get("content-type", "")
                # Should be SSE or JSON error
                assert (
                    "text/event-stream" in content_type
                    or "application/json" in content_type
                )
        except (httpx.HTTPError, httpx.StreamError):
            pytest.skip("Genie endpoint not available")


class TestGenieGetMessage:
    """Tests for GET /api/genie/:alias/conversations/:convId/messages/:msgId."""

    async def test_unknown_alias_returns_404(self, http_client: httpx.AsyncClient):
        response = await http_client.get(
            "/api/genie/nonexistent_alias/conversations/conv-1/messages/msg-1"
        )
        assert response.status_code == 404

    async def test_get_message_returns_sse_or_error(
        self, http_client: httpx.AsyncClient
    ):
        """Getting a message should return SSE or a structured error."""
        try:
            async with http_client.stream(
                "GET",
                "/api/genie/demo/conversations/fake-conv/messages/fake-msg",
                timeout=15.0,
            ) as resp:
                if resp.status_code == 404:
                    pytest.skip("Genie 'demo' space not configured")
                content_type = resp.headers.get("content-type", "")
                assert (
                    "text/event-stream" in content_type
                    or "application/json" in content_type
                )
        except (httpx.HTTPError, httpx.StreamError):
            pytest.skip("Genie endpoint not available")
