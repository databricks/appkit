"""RetryInterceptor with exponential backoff.

Mirrors packages/appkit/src/plugin/interceptors/retry.ts
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

logger = logging.getLogger("appkit.interceptor.retry")


class RetryInterceptor:
    def __init__(
        self,
        attempts: int = 3,
        initial_delay: float = 1.0,
        max_delay: float = 30.0,
    ) -> None:
        self.attempts = attempts
        self.initial_delay = initial_delay
        self.max_delay = max_delay

    async def intercept(self, fn: Callable[[], Awaitable[Any]]) -> Any:
        last_error: Exception | None = None
        for attempt in range(1, self.attempts + 1):
            try:
                return await fn()
            except Exception as exc:
                last_error = exc
                if attempt >= self.attempts:
                    raise
                delay = min(self.initial_delay * (2 ** (attempt - 1)), self.max_delay)
                logger.debug("Retry attempt %d/%d after %.1fs: %s", attempt, self.attempts, delay, exc)
                await asyncio.sleep(delay)
        raise last_error  # type: ignore[misc]
