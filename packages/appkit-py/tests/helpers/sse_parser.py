"""SSE (Server-Sent Events) parser for integration tests.

Parses the exact wire format used by AppKit:
    id: {uuid}
    event: {type}
    data: {json}

Plus heartbeat comments: `: heartbeat\\n\\n`
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

import httpx

UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


@dataclass
class SSEEvent:
    """A single parsed SSE event."""

    id: str | None = None
    event: str | None = None
    data: str | None = None
    is_heartbeat: bool = False
    raw_lines: list[str] = field(default_factory=list)

    @property
    def is_error(self) -> bool:
        return self.event == "error"

    @property
    def parsed_data(self) -> dict | list | None:
        """Parse the data field as JSON. Returns None if no data or parse failure."""
        if self.data is None:
            return None
        try:
            return json.loads(self.data)
        except (json.JSONDecodeError, TypeError):
            return None

    @property
    def has_valid_uuid_id(self) -> bool:
        """Check if the event ID is a valid UUID v4 format."""
        if self.id is None:
            return False
        return bool(UUID_PATTERN.match(self.id))


def parse_sse_text(text: str) -> list[SSEEvent]:
    """Parse raw SSE text into a list of SSEEvent objects.

    Handles the standard SSE format:
    - Lines starting with ':' are comments (heartbeats)
    - Lines with 'field: value' format set event fields
    - Empty lines delimit events
    """
    events: list[SSEEvent] = []
    current_lines: list[str] = []
    current_id: str | None = None
    current_event: str | None = None
    current_data: str | None = None

    for raw_line in text.split("\n"):
        line = raw_line

        # Empty line = event boundary
        if line == "":
            if current_data is not None or current_event is not None or current_id is not None:
                events.append(
                    SSEEvent(
                        id=current_id,
                        event=current_event,
                        data=current_data,
                        is_heartbeat=False,
                        raw_lines=current_lines,
                    )
                )
                current_lines = []
                current_id = None
                current_event = None
                current_data = None
            elif current_lines and all(l.startswith(":") for l in current_lines if l):
                # Comment-only block (heartbeat)
                events.append(
                    SSEEvent(
                        is_heartbeat=True,
                        raw_lines=current_lines,
                    )
                )
                current_lines = []
            continue

        current_lines.append(line)

        # Comment line (heartbeat)
        if line.startswith(":"):
            continue

        # Field: value parsing
        if ":" in line:
            field_name, _, value = line.partition(":")
            value = value.lstrip(" ")  # Strip single leading space per SSE spec

            if field_name == "id":
                current_id = value
            elif field_name == "event":
                current_event = value
            elif field_name == "data":
                if current_data is None:
                    current_data = value
                else:
                    current_data += "\n" + value

    # Handle trailing event without final newline
    if current_data is not None or current_event is not None or current_id is not None:
        events.append(
            SSEEvent(
                id=current_id,
                event=current_event,
                data=current_data,
                is_heartbeat=False,
                raw_lines=current_lines,
            )
        )

    return events


async def parse_sse_response(response: httpx.Response) -> list[SSEEvent]:
    """Parse an httpx response as SSE events."""
    return parse_sse_text(response.text)


async def collect_sse_stream(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    json_body: dict | None = None,
    headers: dict | None = None,
    timeout: float = 30.0,
    max_events: int = 100,
) -> list[SSEEvent]:
    """Make a streaming request and collect SSE events.

    Uses httpx streaming to handle long-lived SSE connections with a timeout.
    """
    events: list[SSEEvent] = []
    buffer = ""

    request_kwargs: dict = {
        "method": method,
        "url": url,
        "timeout": timeout,
        "headers": {**(headers or {}), "Accept": "text/event-stream"},
    }
    if json_body is not None:
        request_kwargs["json"] = json_body

    async with client.stream(**request_kwargs) as response:
        async for chunk in response.aiter_text():
            buffer += chunk
            # Parse complete events from buffer
            while "\n\n" in buffer:
                event_text, buffer = buffer.split("\n\n", 1)
                parsed = parse_sse_text(event_text + "\n\n")
                events.extend(parsed)
                if len(events) >= max_events:
                    return events

    # Parse any remaining buffer
    if buffer.strip():
        events.extend(parse_sse_text(buffer))

    return events


def events_only(events: list[SSEEvent]) -> list[SSEEvent]:
    """Filter out heartbeat events, returning only real events."""
    return [e for e in events if not e.is_heartbeat]


def heartbeats_only(events: list[SSEEvent]) -> list[SSEEvent]:
    """Filter to only heartbeat events."""
    return [e for e in events if e.is_heartbeat]
