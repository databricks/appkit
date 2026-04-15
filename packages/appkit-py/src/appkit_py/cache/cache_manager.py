"""CacheManager with TTL-based in-memory caching.

Mirrors the TypeScript CacheManager from packages/appkit/src/cache/index.ts.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Awaitable, Callable, TypeVar

T = TypeVar("T")


class CacheManager:
    """In-memory TTL cache with SHA256 key generation."""

    _instance: CacheManager | None = None

    def __init__(self) -> None:
        self._store: dict[str, tuple[Any, float]] = {}  # key -> (value, expires_at)

    @classmethod
    def get_instance(cls) -> CacheManager:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def get_instance_sync(cls) -> CacheManager:
        return cls.get_instance()

    @classmethod
    def reset(cls) -> None:
        cls._instance = None

    def generate_key(self, parts: list[Any], user_key: str) -> str:
        """Generate a SHA256 cache key from parts and user key."""
        raw = json.dumps([user_key] + [str(p) for p in parts], sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()

    async def get_or_execute(
        self,
        key_parts: list[Any],
        fn: Callable[[], Awaitable[T]],
        user_key: str,
        ttl: float = 300,
    ) -> T:
        """Get cached value or execute function and cache the result."""
        cache_key = self.generate_key(key_parts, user_key)

        # Check cache
        if cache_key in self._store:
            value, expires_at = self._store[cache_key]
            if time.time() < expires_at:
                return value
            else:
                del self._store[cache_key]

        # Execute and cache
        result = await fn()
        self._store[cache_key] = (result, time.time() + ttl)
        return result

    def get(self, key: str) -> Any | None:
        if key in self._store:
            value, expires_at = self._store[key]
            if time.time() < expires_at:
                return value
            del self._store[key]
        return None

    def set(self, key: str, value: Any, ttl: float = 300) -> None:
        self._store[key] = (value, time.time() + ttl)

    def delete(self, key: str) -> None:
        self._store.pop(key, None)

    def has(self, key: str) -> bool:
        if key in self._store:
            _, expires_at = self._store[key]
            if time.time() < expires_at:
                return True
            del self._store[key]
        return False
