"""StreamManager — core SSE streaming orchestration.

Ports the TypeScript StreamManager from packages/appkit/src/stream/stream-manager.ts.
Handles async generator-based event streams with:
- UUID event IDs
- Ring buffer for reconnection replay (persisted per stream_id)
- Heartbeat keep-alive
- Error event emission
- Graceful abort via tracked disconnect events
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, AsyncGenerator, Callable, Coroutine

from .buffers import BufferedEvent, EventRingBuffer
from .defaults import STREAM_DEFAULTS
from .sse_writer import (
    format_buffered_event,
    format_buffer_overflow_warning,
    format_error,
    format_event,
    format_heartbeat,
)
from .types import SSEErrorCode

logger = logging.getLogger("appkit.stream")

SendFunc = Callable[[str], Coroutine[Any, Any, None]]


class StreamManager:
    """Manages SSE event streaming with reconnection support."""

    def __init__(
        self,
        buffer_size: int = STREAM_DEFAULTS["buffer_size"],
        heartbeat_interval: float = STREAM_DEFAULTS["heartbeat_interval"],
    ) -> None:
        self._buffer_size = buffer_size
        self._heartbeat_interval = heartbeat_interval
        # Persist buffers per stream_id for reconnection replay
        self._stream_buffers: dict[str, EventRingBuffer] = {}
        # Track active disconnect events for abort_all()
        self._active_disconnects: set[asyncio.Event] = set()

    async def stream(
        self,
        send: SendFunc,
        handler: Callable[..., AsyncGenerator[dict[str, Any], None]],
        *,
        on_disconnect: asyncio.Event | None = None,
        last_event_id: str | None = None,
        stream_id: str | None = None,
    ) -> None:
        """Stream events from an async generator to the client."""
        sid = stream_id or str(uuid.uuid4())
        # Get or create a persistent buffer for this stream
        if sid not in self._stream_buffers:
            self._stream_buffers[sid] = EventRingBuffer(capacity=self._buffer_size)
        event_buffer = self._stream_buffers[sid]

        disconnect = on_disconnect or asyncio.Event()
        self._active_disconnects.add(disconnect)
        heartbeat_task: asyncio.Task | None = None

        try:
            heartbeat_task = asyncio.create_task(
                self._heartbeat_loop(send, disconnect)
            )

            # Replay buffered events if reconnecting
            if last_event_id:
                if event_buffer.has_event(last_event_id):
                    missed = event_buffer.get_events_since(last_event_id)
                    if missed:
                        for event in missed:
                            await send(format_buffered_event(event))
                else:
                    # Buffer overflow — event was evicted
                    await send(format_buffer_overflow_warning(last_event_id))

            # Stream events from handler
            async for event in handler(signal=disconnect):
                if disconnect.is_set():
                    break

                event_id = str(uuid.uuid4())
                event_type = str(event.get("type", "message"))
                event_data = json.dumps(event, separators=(",", ":"))

                event_buffer.add_event(
                    BufferedEvent(
                        id=event_id,
                        type=event_type,
                        data=event_data,
                        timestamp=time.time(),
                    )
                )

                await send(format_event(event_id, event))

        except Exception as exc:
            error_id = str(uuid.uuid4())
            error_msg = str(exc) if str(exc) else type(exc).__name__
            try:
                await send(format_error(error_id, error_msg))
            except Exception:
                pass
            logger.error("Stream error: %s", exc)
        finally:
            self._active_disconnects.discard(disconnect)
            if heartbeat_task and not heartbeat_task.done():
                heartbeat_task.cancel()
                try:
                    await heartbeat_task
                except asyncio.CancelledError:
                    pass

    async def _heartbeat_loop(self, send: SendFunc, disconnect: asyncio.Event) -> None:
        """Send periodic heartbeat comments to keep the connection alive."""
        try:
            while not disconnect.is_set():
                await asyncio.sleep(self._heartbeat_interval)
                if not disconnect.is_set():
                    try:
                        await send(format_heartbeat())
                    except Exception:
                        break
        except asyncio.CancelledError:
            pass

    def abort_all(self) -> None:
        """Abort all active streams by setting their disconnect events."""
        for evt in list(self._active_disconnects):
            evt.set()
        self._active_disconnects.clear()
        self._stream_buffers.clear()
