"""Ring buffer implementations for SSE event replay on reconnection.

Ports the TypeScript RingBuffer and EventRingBuffer from
packages/appkit/src/stream/buffers.ts
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Generic, TypeVar

from .types import BufferedEvent

T = TypeVar("T")


class RingBuffer(Generic[T]):
    """Generic FIFO ring buffer with LRU eviction and O(1) key lookup."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._store: OrderedDict[str, T] = OrderedDict()

    def add(self, key: str, value: T) -> None:
        if key in self._store:
            del self._store[key]
        elif len(self._store) >= self._capacity:
            self._store.popitem(last=False)  # Evict oldest
        self._store[key] = value

    def get(self, key: str) -> T | None:
        return self._store.get(key)

    def has(self, key: str) -> bool:
        return key in self._store

    def __len__(self) -> int:
        return len(self._store)

    def keys(self) -> list[str]:
        return list(self._store.keys())

    def values(self) -> list[T]:
        return list(self._store.values())


class EventRingBuffer:
    """Specialized ring buffer for SSE events with get_events_since() for replay."""

    def __init__(self, capacity: int) -> None:
        self._buffer: RingBuffer[BufferedEvent] = RingBuffer(capacity)
        self._order: list[str] = []  # Maintain insertion order for replay
        self._capacity = capacity

    def add_event(self, event: BufferedEvent) -> None:
        self._buffer.add(event.id, event)
        self._order.append(event.id)
        # Trim order list to capacity
        if len(self._order) > self._capacity:
            self._order = self._order[-self._capacity :]

    def has_event(self, event_id: str) -> bool:
        return self._buffer.has(event_id)

    def get_events_since(self, event_id: str) -> list[BufferedEvent] | None:
        """Get all events after the given event ID.

        Returns None if the event_id is not in the buffer (buffer overflow).
        Returns an empty list if event_id is the last event.
        """
        if not self._buffer.has(event_id):
            return None

        try:
            idx = self._order.index(event_id)
        except ValueError:
            return None

        result: list[BufferedEvent] = []
        for eid in self._order[idx + 1 :]:
            event = self._buffer.get(eid)
            if event is not None:
                result.append(event)
        return result
