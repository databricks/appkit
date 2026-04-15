"""CacheInterceptor wrapping CacheManager.

Mirrors packages/appkit/src/plugin/interceptors/cache.ts
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable


class CacheInterceptor:
    def __init__(
        self,
        cache_store: dict[str, Any],
        cache_key: str | None,
        ttl: float = 300,
        enabled: bool = True,
    ) -> None:
        self._store = cache_store
        self._key = cache_key
        self._ttl = ttl
        self._enabled = enabled

    async def intercept(self, fn: Callable[[], Awaitable[Any]]) -> Any:
        if not self._enabled or not self._key:
            return await fn()

        if self._key in self._store:
            return self._store[self._key]

        result = await fn()
        if self._key:
            self._store[self._key] = result
        return result
