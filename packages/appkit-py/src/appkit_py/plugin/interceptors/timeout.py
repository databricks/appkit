"""TimeoutInterceptor using asyncio.wait_for.

Mirrors packages/appkit/src/plugin/interceptors/timeout.ts
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable


class TimeoutInterceptor:
    def __init__(self, timeout_seconds: float) -> None:
        self.timeout_seconds = timeout_seconds

    async def intercept(self, fn: Callable[[], Awaitable[Any]]) -> Any:
        return await asyncio.wait_for(fn(), timeout=self.timeout_seconds)
