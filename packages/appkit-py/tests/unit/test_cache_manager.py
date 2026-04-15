"""Unit tests for CacheManager."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit


class TestCacheManager:
    def test_import(self):
        from appkit_py.cache.cache_manager import CacheManager

        mgr = CacheManager()
        assert mgr is not None

    async def test_get_or_execute_miss(self):
        from appkit_py.cache.cache_manager import CacheManager

        mgr = CacheManager()
        call_count = 0

        async def compute():
            nonlocal call_count
            call_count += 1
            return {"result": 42}

        result = await mgr.get_or_execute(
            key_parts=["test", "query1"],
            fn=compute,
            user_key="user-1",
            ttl=60,
        )
        assert result == {"result": 42}
        assert call_count == 1

    async def test_get_or_execute_hit(self):
        from appkit_py.cache.cache_manager import CacheManager

        mgr = CacheManager()
        call_count = 0

        async def compute():
            nonlocal call_count
            call_count += 1
            return {"result": 42}

        # First call — miss
        await mgr.get_or_execute(["test", "q"], compute, "user-1", ttl=60)
        # Second call — should be cached
        result = await mgr.get_or_execute(["test", "q"], compute, "user-1", ttl=60)
        assert result == {"result": 42}
        assert call_count == 1  # Only called once

    async def test_different_users_separate_cache(self):
        from appkit_py.cache.cache_manager import CacheManager

        mgr = CacheManager()
        calls: list[str] = []

        async def compute_for(user: str):
            calls.append(user)
            return f"result-{user}"

        r1 = await mgr.get_or_execute(["q"], lambda: compute_for("a"), "user-a", ttl=60)
        r2 = await mgr.get_or_execute(["q"], lambda: compute_for("b"), "user-b", ttl=60)
        assert r1 == "result-a"
        assert r2 == "result-b"
        assert len(calls) == 2  # Both users computed separately

    async def test_generate_key_deterministic(self):
        from appkit_py.cache.cache_manager import CacheManager

        mgr = CacheManager()
        k1 = mgr.generate_key(["a", "b", 1], "user")
        k2 = mgr.generate_key(["a", "b", 1], "user")
        assert k1 == k2

    async def test_generate_key_different_for_different_inputs(self):
        from appkit_py.cache.cache_manager import CacheManager

        mgr = CacheManager()
        k1 = mgr.generate_key(["a"], "user-1")
        k2 = mgr.generate_key(["b"], "user-1")
        k3 = mgr.generate_key(["a"], "user-2")
        assert k1 != k2
        assert k1 != k3

    async def test_delete(self):
        from appkit_py.cache.cache_manager import CacheManager

        mgr = CacheManager()
        call_count = 0

        async def compute():
            nonlocal call_count
            call_count += 1
            return "value"

        await mgr.get_or_execute(["k"], compute, "u", ttl=60)
        key = mgr.generate_key(["k"], "u")
        mgr.delete(key)

        # Should recompute after deletion
        await mgr.get_or_execute(["k"], compute, "u", ttl=60)
        assert call_count == 2
