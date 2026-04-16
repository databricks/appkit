"""Integration tests for CacheConfig and CacheManager."""

import asyncio

import pytest

import appkit


class TestCacheConfig:
    def test_defaults(self):
        cfg = appkit.CacheConfig()
        assert cfg.enabled is True
        assert cfg.ttl == 3600
        assert cfg.max_size == 1000
        assert cfg.cleanup_probability == pytest.approx(0.01)

    def test_custom_values(self, cache_config):
        assert cache_config.ttl == 10
        assert cache_config.max_size == 50

    def test_repr(self):
        r = repr(appkit.CacheConfig())
        assert "CacheConfig" in r
        assert "3600" in r

    def test_equality(self):
        a = appkit.CacheConfig(ttl=60)
        b = appkit.CacheConfig(ttl=60)
        c = appkit.CacheConfig(ttl=120)
        assert a == b
        assert a != c

    def test_hashable(self):
        cfg = appkit.CacheConfig()
        s = {cfg}
        assert len(s) == 1

    def test_frozen(self):
        cfg = appkit.CacheConfig()
        with pytest.raises(AttributeError):
            cfg.ttl = 999


class TestCacheManager:
    def test_constructor(self):
        cm = appkit.CacheManager()
        assert repr(cm).startswith("CacheManager")

    def test_with_config(self, cache_config):
        cm = appkit.CacheManager(cache_config)
        assert bool(cm) is True

    def test_disabled(self):
        cfg = appkit.CacheConfig(enabled=False)
        cm = appkit.CacheManager(cfg)
        assert bool(cm) is False

    def test_generate_key_deterministic(self):
        k1 = appkit.CacheManager.generate_key(["q", "p"], "user-1")
        k2 = appkit.CacheManager.generate_key(["q", "p"], "user-1")
        assert k1 == k2
        assert len(k1) == 64  # SHA256 hex

    def test_generate_key_varies_by_user(self):
        k1 = appkit.CacheManager.generate_key(["q"], "alice")
        k2 = appkit.CacheManager.generate_key(["q"], "bob")
        assert k1 != k2

    @pytest.mark.asyncio
    async def test_set_get_delete(self):
        cm = appkit.CacheManager()
        await cm.set("key1", '{"value": 42}')
        result = await cm.get("key1")
        assert result is not None
        assert "42" in result

        await cm.delete("key1")
        result = await cm.get("key1")
        assert result is None

    @pytest.mark.asyncio
    async def test_has_and_size(self):
        cm = appkit.CacheManager()
        assert await cm.has("nonexistent") is False
        assert await cm.size() == 0

        await cm.set("k", '"v"')
        assert await cm.has("k") is True
        assert await cm.size() == 1

    @pytest.mark.asyncio
    async def test_clear(self):
        cm = appkit.CacheManager()
        await cm.set("a", '"1"')
        await cm.set("b", '"2"')
        assert await cm.size() == 2

        await cm.clear()
        assert await cm.size() == 0

    @pytest.mark.asyncio
    async def test_get_or_execute(self):
        cm = appkit.CacheManager()
        call_count = 0

        async def compute():
            nonlocal call_count
            call_count += 1
            return '{"computed": true}'

        # First call executes
        result = await cm.get_or_execute("k", compute)
        assert "computed" in result
        assert call_count == 1

        # Second call hits cache
        result = await cm.get_or_execute("k", compute)
        assert "computed" in result
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_set_with_custom_ttl(self):
        cm = appkit.CacheManager(appkit.CacheConfig(ttl=3600))
        await cm.set("k", '"v"', ttl=0)
        # With ttl=0, entry expires almost immediately
        await asyncio.sleep(0.01)
        result = await cm.get("k")
        assert result is None
