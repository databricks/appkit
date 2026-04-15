"""Unit tests for the execution interceptor chain.

Interceptor order (outermost to innermost):
    Telemetry → Timeout → Retry → Cache
"""

from __future__ import annotations

import asyncio

import pytest

pytestmark = pytest.mark.unit


class TestRetryInterceptor:
    """Tests for RetryInterceptor with exponential backoff."""

    async def test_success_on_first_attempt(self):
        from appkit_py.plugin.interceptors.retry import RetryInterceptor

        interceptor = RetryInterceptor(attempts=3, initial_delay=0.01, max_delay=0.1)
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            return "ok"

        result = await interceptor.intercept(fn)
        assert result == "ok"
        assert call_count == 1

    async def test_retry_on_failure(self):
        from appkit_py.plugin.interceptors.retry import RetryInterceptor

        interceptor = RetryInterceptor(attempts=3, initial_delay=0.01, max_delay=0.1)
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise RuntimeError("temporary failure")
            return "ok"

        result = await interceptor.intercept(fn)
        assert result == "ok"
        assert call_count == 3

    async def test_exhausted_retries_raises(self):
        from appkit_py.plugin.interceptors.retry import RetryInterceptor

        interceptor = RetryInterceptor(attempts=2, initial_delay=0.01, max_delay=0.1)

        async def fn():
            raise RuntimeError("permanent failure")

        with pytest.raises(RuntimeError, match="permanent failure"):
            await interceptor.intercept(fn)

    async def test_no_retry_when_attempts_is_one(self):
        from appkit_py.plugin.interceptors.retry import RetryInterceptor

        interceptor = RetryInterceptor(attempts=1, initial_delay=0.01, max_delay=0.1)
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            raise RuntimeError("fail")

        with pytest.raises(RuntimeError):
            await interceptor.intercept(fn)
        assert call_count == 1


class TestTimeoutInterceptor:
    """Tests for TimeoutInterceptor."""

    async def test_completes_within_timeout(self):
        from appkit_py.plugin.interceptors.timeout import TimeoutInterceptor

        interceptor = TimeoutInterceptor(timeout_seconds=5.0)

        async def fn():
            return "fast"

        result = await interceptor.intercept(fn)
        assert result == "fast"

    async def test_timeout_raises(self):
        from appkit_py.plugin.interceptors.timeout import TimeoutInterceptor

        interceptor = TimeoutInterceptor(timeout_seconds=0.05)

        async def fn():
            await asyncio.sleep(10)
            return "slow"

        with pytest.raises((asyncio.TimeoutError, TimeoutError)):
            await interceptor.intercept(fn)


class TestCacheInterceptor:
    """Tests for CacheInterceptor."""

    async def test_cache_miss_executes_function(self):
        from appkit_py.plugin.interceptors.cache import CacheInterceptor

        cache_store: dict[str, object] = {}
        interceptor = CacheInterceptor(
            cache_store=cache_store, cache_key="test-key", ttl=60
        )
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            return {"data": "result"}

        result = await interceptor.intercept(fn)
        assert result == {"data": "result"}
        assert call_count == 1

    async def test_cache_hit_skips_function(self):
        from appkit_py.plugin.interceptors.cache import CacheInterceptor

        cache_store: dict[str, object] = {"test-key": {"data": "cached"}}
        interceptor = CacheInterceptor(
            cache_store=cache_store, cache_key="test-key", ttl=60
        )
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            return {"data": "fresh"}

        result = await interceptor.intercept(fn)
        assert result == {"data": "cached"}
        assert call_count == 0

    async def test_cache_disabled_always_executes(self):
        from appkit_py.plugin.interceptors.cache import CacheInterceptor

        interceptor = CacheInterceptor(
            cache_store={}, cache_key=None, ttl=60, enabled=False
        )
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            return "result"

        await interceptor.intercept(fn)
        await interceptor.intercept(fn)
        assert call_count == 2
