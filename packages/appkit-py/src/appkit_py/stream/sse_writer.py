"""SSE wire format writer matching the TypeScript SSEWriter.

Produces the exact format expected by the AppKit frontend:
    id: {uuid}
    event: {type}
    data: {json}
    (empty line)

Plus heartbeat comments: `: heartbeat\\n\\n`
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Coroutine

from .types import BufferedEvent, SSEErrorCode, SSEWarningCode


def sanitize_event_type(event_type: str) -> str:
    """Sanitize SSE event type: remove newlines, cap at 100 chars."""
    sanitized = re.sub(r"[\r\n]", "", event_type)
    return sanitized[:100]


def format_event(event_id: str, event: dict[str, Any]) -> str:
    """Format a single SSE event as a string."""
    event_type = sanitize_event_type(str(event.get("type", "message")))
    event_data = json.dumps(event, separators=(",", ":"))
    return f"id: {event_id}\nevent: {event_type}\ndata: {event_data}\n\n"


def format_error(event_id: str, error: str, code: SSEErrorCode = SSEErrorCode.INTERNAL_ERROR) -> str:
    """Format an SSE error event."""
    data = json.dumps({"error": error, "code": code.value}, separators=(",", ":"))
    return f"id: {event_id}\nevent: error\ndata: {data}\n\n"


def format_buffered_event(event: BufferedEvent) -> str:
    """Format a buffered event for replay."""
    event_type = sanitize_event_type(event.type)
    return f"id: {event.id}\nevent: {event_type}\ndata: {event.data}\n\n"


def format_heartbeat() -> str:
    """Format an SSE heartbeat comment."""
    return ": heartbeat\n\n"


def format_buffer_overflow_warning(last_event_id: str) -> str:
    """Format a buffer overflow warning."""
    data = json.dumps({
        "warning": "Buffer overflow detected - some events were lost",
        "code": SSEWarningCode.BUFFER_OVERFLOW_RESTART.value,
        "lastEventId": last_event_id,
    }, separators=(",", ":"))
    return f"event: warning\ndata: {data}\n\n"


SSE_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Encoding": "none",
    "X-Accel-Buffering": "no",
}
