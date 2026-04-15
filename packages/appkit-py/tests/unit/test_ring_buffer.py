"""Unit tests for RingBuffer and EventRingBuffer.

These test the SSE event buffering used for stream reconnection.
"""

from __future__ import annotations

import time

import pytest

pytestmark = pytest.mark.unit


class TestRingBuffer:
    """Tests for the generic RingBuffer."""

    def test_import(self):
        """RingBuffer should be importable from appkit_py.stream.buffers."""
        from appkit_py.stream.buffers import RingBuffer

        buf = RingBuffer(capacity=5)
        assert buf is not None

    def test_add_and_retrieve(self):
        from appkit_py.stream.buffers import RingBuffer

        buf: RingBuffer[str] = RingBuffer(capacity=5)
        buf.add("key1", "value1")
        assert buf.get("key1") == "value1"

    def test_capacity_eviction(self):
        from appkit_py.stream.buffers import RingBuffer

        buf: RingBuffer[str] = RingBuffer(capacity=3)
        buf.add("a", "1")
        buf.add("b", "2")
        buf.add("c", "3")
        buf.add("d", "4")  # Should evict "a"
        assert buf.get("a") is None
        assert buf.get("d") == "4"

    def test_lru_eviction_order(self):
        from appkit_py.stream.buffers import RingBuffer

        buf: RingBuffer[str] = RingBuffer(capacity=3)
        buf.add("a", "1")
        buf.add("b", "2")
        buf.add("c", "3")
        # Oldest (a) should be evicted first
        buf.add("d", "4")
        assert buf.get("a") is None
        assert buf.get("b") == "2"

    def test_size_tracking(self):
        from appkit_py.stream.buffers import RingBuffer

        buf: RingBuffer[str] = RingBuffer(capacity=5)
        assert len(buf) == 0
        buf.add("a", "1")
        assert len(buf) == 1
        buf.add("b", "2")
        assert len(buf) == 2


class TestEventRingBuffer:
    """Tests for the SSE-specific EventRingBuffer."""

    def test_import(self):
        from appkit_py.stream.buffers import EventRingBuffer

        buf = EventRingBuffer(capacity=10)
        assert buf is not None

    def test_add_event(self):
        from appkit_py.stream.buffers import BufferedEvent, EventRingBuffer

        buf = EventRingBuffer(capacity=10)
        event = BufferedEvent(
            id="evt-1", type="message", data='{"text":"hello"}', timestamp=time.time()
        )
        buf.add_event(event)
        assert buf.has_event("evt-1")

    def test_get_events_since(self):
        from appkit_py.stream.buffers import BufferedEvent, EventRingBuffer

        buf = EventRingBuffer(capacity=10)
        now = time.time()
        for i in range(5):
            buf.add_event(
                BufferedEvent(
                    id=f"evt-{i}", type="msg", data=f'{{"i":{i}}}', timestamp=now + i
                )
            )

        # Get events after evt-2 (should return evt-3, evt-4)
        since = buf.get_events_since("evt-2")
        assert since is not None
        assert len(since) == 2
        assert since[0].id == "evt-3"
        assert since[1].id == "evt-4"

    def test_get_events_since_missing_id(self):
        from appkit_py.stream.buffers import BufferedEvent, EventRingBuffer

        buf = EventRingBuffer(capacity=10)
        buf.add_event(
            BufferedEvent(id="evt-1", type="msg", data="{}", timestamp=time.time())
        )
        # Non-existent ID means buffer overflow — return None
        result = buf.get_events_since("nonexistent")
        assert result is None

    def test_buffer_overflow_eviction(self):
        from appkit_py.stream.buffers import BufferedEvent, EventRingBuffer

        buf = EventRingBuffer(capacity=3)
        now = time.time()
        for i in range(5):
            buf.add_event(
                BufferedEvent(id=f"evt-{i}", type="msg", data="{}", timestamp=now + i)
            )

        # First two should be evicted
        assert not buf.has_event("evt-0")
        assert not buf.has_event("evt-1")
        assert buf.has_event("evt-2")
        assert buf.has_event("evt-3")
        assert buf.has_event("evt-4")
