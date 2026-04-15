"""Integration tests for the SSE (Server-Sent Events) protocol.

These tests validate the SSE wire format is correct and compatible with
the AppKit frontend's SSE client (connectSSE). They can run against any
SSE-producing endpoint — we use the reconnect plugin if available, or
analytics/genie endpoints.

The exact SSE format required by the frontend:
    id: {uuid}
    event: {event_type}
    data: {json_string}
    (empty line)

Plus heartbeat comments: `: heartbeat\\n\\n`
"""

from __future__ import annotations

import json

import httpx
import pytest

from tests.helpers.sse_parser import (
    SSEEvent,
    collect_sse_stream,
    events_only,
    parse_sse_text,
)

pytestmark = pytest.mark.integration


class TestSSEParser:
    """Verify our SSE parser correctly handles the wire format."""

    def test_parse_basic_event(self):
        text = "id: abc-123\nevent: result\ndata: {\"type\":\"result\"}\n\n"
        events = parse_sse_text(text)
        real = events_only(events)
        assert len(real) == 1
        assert real[0].id == "abc-123"
        assert real[0].event == "result"
        assert real[0].data == '{"type":"result"}'

    def test_parse_heartbeat(self):
        text = ": heartbeat\n\n"
        events = parse_sse_text(text)
        assert len(events) == 1
        assert events[0].is_heartbeat is True

    def test_parse_multiple_events(self):
        text = (
            "id: 1\nevent: a\ndata: {}\n\n"
            ": heartbeat\n\n"
            "id: 2\nevent: b\ndata: {}\n\n"
        )
        events = parse_sse_text(text)
        assert len(events) == 3
        real = events_only(events)
        assert len(real) == 2

    def test_parse_error_event(self):
        text = 'id: err-1\nevent: error\ndata: {"error":"fail","code":"INTERNAL_ERROR"}\n\n'
        events = events_only(parse_sse_text(text))
        assert len(events) == 1
        assert events[0].is_error is True
        data = events[0].parsed_data
        assert data["error"] == "fail"
        assert data["code"] == "INTERNAL_ERROR"

    def test_uuid_validation(self):
        event = SSEEvent(id="550e8400-e29b-41d4-a716-446655440000")
        assert event.has_valid_uuid_id is True

        event = SSEEvent(id="not-a-uuid")
        assert event.has_valid_uuid_id is False

        event = SSEEvent(id=None)
        assert event.has_valid_uuid_id is False


class TestSSEProtocolCompliance:
    """Tests that validate SSE protocol compliance against a running server.

    These require the reconnect plugin or any streaming endpoint to be available.
    If no streaming endpoint is available, tests are skipped.
    """

    @pytest.fixture
    async def sse_events(self, http_client: httpx.AsyncClient) -> list[SSEEvent] | None:
        """Try to get SSE events from a known streaming endpoint.

        Tries the reconnect plugin first, then analytics with a dummy query.
        Returns None if no streaming endpoint is available.
        """
        # Try reconnect plugin (dev-playground specific)
        try:
            events = await collect_sse_stream(
                http_client, "GET", "/api/reconnect/stream", timeout=15.0, max_events=3
            )
            if events:
                return events
        except (httpx.HTTPError, httpx.StreamError):
            pass

        return None

    async def _find_sse_endpoint(self, client: httpx.AsyncClient) -> tuple[str, str, dict | None]:
        """Find a working SSE endpoint. Returns (method, url, json_body)."""
        # Try reconnect plugin first (TS dev-playground only)
        try:
            async with client.stream("GET", "/api/reconnect/stream", timeout=3.0) as resp:
                if "text/event-stream" in resp.headers.get("content-type", ""):
                    return ("GET", "/api/reconnect/stream", None)
        except (httpx.HTTPError, httpx.StreamError):
            pass

        # Try genie with a known alias (requires genie space configured)
        try:
            async with client.stream(
                "POST", "/api/genie/demo/messages",
                json={"content": "test"}, timeout=3.0
            ) as resp:
                if "text/event-stream" in resp.headers.get("content-type", ""):
                    return ("POST", "/api/genie/demo/messages", {"content": "test"})
        except (httpx.HTTPError, httpx.StreamError):
            pass

        # Try analytics with any query
        try:
            async with client.stream(
                "POST", "/api/analytics/query/test",
                json={"format": "JSON"}, timeout=3.0
            ) as resp:
                if "text/event-stream" in resp.headers.get("content-type", ""):
                    return ("POST", "/api/analytics/query/test", {"format": "JSON"})
        except (httpx.HTTPError, httpx.StreamError):
            pass

        raise RuntimeError("No SSE endpoint available")

    async def test_sse_content_type(self, http_client: httpx.AsyncClient):
        """SSE endpoints must return Content-Type: text/event-stream."""
        try:
            method, url, body = await self._find_sse_endpoint(http_client)
            kwargs: dict = {"timeout": 5.0}
            if body:
                kwargs["json"] = body
            async with http_client.stream(method, url, **kwargs) as resp:
                content_type = resp.headers.get("content-type", "")
                assert "text/event-stream" in content_type
        except RuntimeError:
            pytest.skip("No streaming endpoint available")

    async def test_sse_cache_control(self, http_client: httpx.AsyncClient):
        """SSE endpoints must set Cache-Control: no-cache."""
        try:
            method, url, body = await self._find_sse_endpoint(http_client)
            kwargs: dict = {"timeout": 5.0}
            if body:
                kwargs["json"] = body
            async with http_client.stream(method, url, **kwargs) as resp:
                cache_control = resp.headers.get("cache-control", "")
                assert "no-cache" in cache_control
        except RuntimeError:
            pytest.skip("No streaming endpoint available")

    async def test_sse_event_has_id_event_data(self, sse_events: list[SSEEvent] | None):
        """Each SSE event must have id, event, and data fields."""
        if sse_events is None:
            pytest.skip("No streaming endpoint available")

        real = events_only(sse_events)
        if not real:
            pytest.skip("No real events received")

        for event in real:
            assert event.id is not None, f"Event missing id: {event.raw_lines}"
            assert event.event is not None, f"Event missing event type: {event.raw_lines}"
            assert event.data is not None, f"Event missing data: {event.raw_lines}"

    async def test_sse_event_ids_are_uuids(self, sse_events: list[SSEEvent] | None):
        """Event IDs should be UUID v4 format."""
        if sse_events is None:
            pytest.skip("No streaming endpoint available")

        real = events_only(sse_events)
        if not real:
            pytest.skip("No real events received")

        for event in real:
            assert event.has_valid_uuid_id, f"Event ID is not UUID: {event.id}"

    async def test_sse_data_is_valid_json(self, sse_events: list[SSEEvent] | None):
        """Event data fields must be valid JSON."""
        if sse_events is None:
            pytest.skip("No streaming endpoint available")

        real = events_only(sse_events)
        if not real:
            pytest.skip("No real events received")

        for event in real:
            assert event.data is not None
            try:
                json.loads(event.data)
            except json.JSONDecodeError:
                pytest.fail(f"Event data is not valid JSON: {event.data[:100]}")

    async def test_sse_error_event_format(self):
        """Error events must have the format: {error: string, code: SSEErrorCode}."""
        error_text = (
            'id: e1\nevent: error\n'
            'data: {"error":"Something failed","code":"INTERNAL_ERROR"}\n\n'
        )
        events = events_only(parse_sse_text(error_text))
        assert len(events) == 1
        data = events[0].parsed_data
        assert "error" in data
        assert "code" in data
        valid_codes = {
            "TEMPORARY_UNAVAILABLE",
            "TIMEOUT",
            "INTERNAL_ERROR",
            "INVALID_REQUEST",
            "STREAM_ABORTED",
            "STREAM_EVICTED",
        }
        assert data["code"] in valid_codes
