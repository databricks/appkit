"""SSE stream types mirroring the TypeScript implementation."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class SSEErrorCode(str, enum.Enum):
    TEMPORARY_UNAVAILABLE = "TEMPORARY_UNAVAILABLE"
    TIMEOUT = "TIMEOUT"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    INVALID_REQUEST = "INVALID_REQUEST"
    STREAM_ABORTED = "STREAM_ABORTED"
    STREAM_EVICTED = "STREAM_EVICTED"


class SSEWarningCode(str, enum.Enum):
    BUFFER_OVERFLOW_RESTART = "BUFFER_OVERFLOW_RESTART"


@dataclass
class BufferedEvent:
    id: str
    type: str
    data: str
    timestamp: float
