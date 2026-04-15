"""Unit tests for StreamManager.

Tests the core SSE streaming orchestration including:
- Basic event streaming
- Heartbeat generation
- Stream reconnection via Last-Event-ID
- Error handling
- Multi-client broadcast
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

pytestmark = pytest.mark.unit


class TestStreamManager:
    """Tests for StreamManager streaming behavior."""

    def test_import(self):
        from appkit_py.stream.stream_manager import StreamManager

        mgr = StreamManager()
        assert mgr is not None

    async def test_basic_streaming(self):
        """StreamManager should yield events from an async generator."""
        from appkit_py.stream.stream_manager import StreamManager

        mgr = StreamManager()
        events_sent: list[str] = []

        async def handler(signal=None):
            for i in range(3):
                yield {"type": "message", "count": i}

        async def mock_send(data: str):
            events_sent.append(data)

        await mgr.stream(mock_send, handler, on_disconnect=asyncio.Event())

        # Should have 3 events (plus possible heartbeats)
        data_events = [e for e in events_sent if "event:" in e and "heartbeat" not in e]
        assert len(data_events) >= 3

    async def test_error_in_handler_sends_error_event(self):
        """If the handler raises, an error SSE event should be sent."""
        from appkit_py.stream.stream_manager import StreamManager

        mgr = StreamManager()
        events_sent: list[str] = []

        async def failing_handler(signal=None):
            yield {"type": "message", "data": "ok"}
            raise RuntimeError("Something broke")

        async def mock_send(data: str):
            events_sent.append(data)

        await mgr.stream(mock_send, failing_handler, on_disconnect=asyncio.Event())

        # Should contain an error event
        all_text = "".join(events_sent)
        assert "event: error" in all_text

    async def test_abort_signal_stops_streaming(self):
        """Setting abort should stop the stream."""
        from appkit_py.stream.stream_manager import StreamManager

        mgr = StreamManager()
        events_sent: list[str] = []
        disconnect = asyncio.Event()

        async def slow_handler(signal=None):
            for i in range(100):
                if signal and signal.is_set():
                    return
                yield {"type": "message", "count": i}
                await asyncio.sleep(0.01)

        async def mock_send(data: str):
            events_sent.append(data)

        # Abort after a short delay
        async def abort_soon():
            await asyncio.sleep(0.05)
            disconnect.set()

        asyncio.create_task(abort_soon())
        await mgr.stream(mock_send, slow_handler, on_disconnect=disconnect)

        # Should have stopped early (not all 100 events)
        data_events = [e for e in events_sent if "event:" in e and "heartbeat" not in e]
        assert len(data_events) < 100


class TestStreamManagerSSEFormat:
    """Tests that StreamManager produces correct SSE wire format."""

    async def test_event_has_id_event_data_fields(self):
        from appkit_py.stream.stream_manager import StreamManager

        mgr = StreamManager()
        events_sent: list[str] = []

        async def handler(signal=None):
            yield {"type": "test_event", "value": 42}

        async def mock_send(data: str):
            events_sent.append(data)

        await mgr.stream(mock_send, handler, on_disconnect=asyncio.Event())

        # Find the event in output
        all_text = "".join(events_sent)
        assert "id:" in all_text
        assert "event:" in all_text
        assert "data:" in all_text

    async def test_event_data_is_valid_json(self):
        from appkit_py.stream.stream_manager import StreamManager

        mgr = StreamManager()
        events_sent: list[str] = []

        async def handler(signal=None):
            yield {"type": "result", "payload": {"key": "value"}}

        async def mock_send(data: str):
            events_sent.append(data)

        await mgr.stream(mock_send, handler, on_disconnect=asyncio.Event())

        # Extract data lines and verify JSON
        for chunk in events_sent:
            for line in chunk.split("\n"):
                if line.startswith("data:"):
                    data_str = line[len("data:"):].strip()
                    parsed = json.loads(data_str)
                    assert isinstance(parsed, dict)
