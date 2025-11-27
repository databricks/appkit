import { TelemetryManager, type TelemetryProvider } from "../../telemetry";
import { createMockTelemetry } from "@tools/test-helpers";
import { CacheManager } from "../../cache";
import type { CacheConfig } from "shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CacheInterceptor } from "../interceptors/cache";
import type { ExecutionContext } from "../interceptors/types";

vi.mock("../../telemetry", () => ({
  TelemetryManager: {
    getProvider: vi.fn(),
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
}));

/** Mock CacheManager for testing */
class MockCacheManager {
  private cache = new Map<string, { value: unknown; expiry: number }>();
  private inFlightRequests = new Map<string, Promise<unknown>>();

  async getOrExecute<T>(
    key: (string | number | object)[],
    fn: () => Promise<T>,
    userKey: string,
    options?: { ttl?: number },
  ): Promise<T> {
    const cacheKey = this.generateKey(key, userKey);
    const cached = await this.get<T>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const inFlight = this.inFlightRequests.get(cacheKey);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    const promise = fn()
      .then(async (result) => {
        await this.set(cacheKey, result, options);
        return result;
      })
      .finally(() => {
        this.inFlightRequests.delete(cacheKey);
      });

    this.inFlightRequests.set(cacheKey, promise);
    return promise;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(
    key: string,
    value: T,
    options?: { ttl?: number },
  ): Promise<void> {
    const expiryTime = Date.now() + (options?.ttl ?? 3600) * 1000;
    this.cache.set(key, { value, expiry: expiryTime });
  }

  generateKey(parts: (string | number | object)[], userKey: string): string {
    const { createHash } = require("node:crypto");
    const allParts = [userKey, ...parts];
    const serialized = JSON.stringify(allParts);
    return createHash("sha256").update(serialized).digest("hex");
  }
}

describe("CacheInterceptor", () => {
  let cacheManager: MockCacheManager;
  let context: ExecutionContext;

  beforeEach(() => {
    cacheManager = new MockCacheManager();
    context = {
      metadata: new Map(),
      userKey: "service",
    };
  });

  test("should bypass cache when disabled", async () => {
    const config: CacheConfig = {
      enabled: false,
      cacheKey: ["test"],
    };
    const interceptor = new CacheInterceptor(
      cacheManager as unknown as ConstructorParameters<
        typeof CacheInterceptor
      >[0],
      config,
    );
    const fn = vi.fn().mockResolvedValue("result");

    const result = await interceptor.intercept(fn, context);

    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("should bypass cache when no cacheKey provided", async () => {
    const config: CacheConfig = {
      enabled: true,
      cacheKey: [],
    };
    const interceptor = new CacheInterceptor(
      cacheManager as unknown as ConstructorParameters<
        typeof CacheInterceptor
      >[0],
      config,
    );
    const fn = vi.fn().mockResolvedValue("result");

    const result = await interceptor.intercept(fn, context);

    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("should return cached result on cache hit", async () => {
    const config: CacheConfig = {
      enabled: true,
      cacheKey: ["test", "key"],
    };
    const interceptor = new CacheInterceptor(
      cacheManager as unknown as ConstructorParameters<
        typeof CacheInterceptor
      >[0],
      config,
    );

    // Pre-populate cache
    const cacheKey = cacheManager.generateKey(["test", "key"], "service");
    await cacheManager.set(cacheKey, "cached-result");

    const fn = vi.fn().mockResolvedValue("new-result");

    const result = await interceptor.intercept(fn, context);

    expect(result).toBe("cached-result");
    expect(fn).not.toHaveBeenCalled(); // Function should not execute
  });

  test("should execute function and cache result on cache miss", async () => {
    const config: CacheConfig = {
      enabled: true,
      cacheKey: ["test", "key"],
      ttl: 3600,
    };
    const interceptor = new CacheInterceptor(
      cacheManager as unknown as ConstructorParameters<
        typeof CacheInterceptor
      >[0],
      config,
    );
    const fn = vi.fn().mockResolvedValue("fresh-result");

    const result = await interceptor.intercept(fn, context);

    expect(result).toBe("fresh-result");
    expect(fn).toHaveBeenCalledTimes(1);

    // Verify result was cached
    const cacheKey = cacheManager.generateKey(["test", "key"], "service");
    const cached = await cacheManager.get(cacheKey);
    expect(cached).toBe("fresh-result");
  });

  test("should include userToken in cache key when present", async () => {
    const config: CacheConfig = {
      enabled: true,
      cacheKey: ["query", "sales"],
    };
    const contextWithToken: ExecutionContext = {
      metadata: new Map(),
      userKey: "user1",
    };
    const interceptor = new CacheInterceptor(
      cacheManager as unknown as ConstructorParameters<
        typeof CacheInterceptor
      >[0],
      config,
    );
    const fn = vi.fn().mockResolvedValue("user-result");

    await interceptor.intercept(fn, contextWithToken);

    // Cache key should include userKey
    const cacheKey = cacheManager.generateKey(["query", "sales"], "user1");
    const cached = await cacheManager.get(cacheKey);
    expect(cached).toBe("user-result");
  });

  test("should cache different results for different users", async () => {
    const config: CacheConfig = {
      enabled: true,
      cacheKey: ["query", "profile"],
    };
    const interceptor = new CacheInterceptor(
      cacheManager as unknown as ConstructorParameters<
        typeof CacheInterceptor
      >[0],
      config,
    );

    // Service account context
    const context1: ExecutionContext = {
      metadata: new Map(),
      userKey: "service",
    };
    const fn1 = vi.fn().mockResolvedValue("service-account-data");
    await interceptor.intercept(fn1, context1);

    // User context
    const context2: ExecutionContext = {
      metadata: new Map(),
      userKey: "user1",
    };
    const fn2 = vi.fn().mockResolvedValue("user-data");
    await interceptor.intercept(fn2, context2);

    // Both should have executed
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);

    // Verify separate cache entries
    const key1 = cacheManager.generateKey(["query", "profile"], "service");
    const key2 = cacheManager.generateKey(["query", "profile"], "user1");
    expect(await cacheManager.get(key1)).toBe("service-account-data");
    expect(await cacheManager.get(key2)).toBe("user-data");
  });

  test("should respect TTL setting", async () => {
    const config: CacheConfig = {
      enabled: true,
      cacheKey: ["test"],
      ttl: 1, // 1 second
    };
    const interceptor = new CacheInterceptor(
      cacheManager as unknown as ConstructorParameters<
        typeof CacheInterceptor
      >[0],
      config,
    );
    const fn = vi.fn().mockResolvedValue("result");

    await interceptor.intercept(fn, context);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Second call should execute function again
    await interceptor.intercept(fn, context);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("should work correctly with telemetry enabled", async () => {
    // Create telemetry with traces enabled
    const mockTelemetryWithTraces = createMockTelemetry();
    vi.mocked(TelemetryManager.getProvider).mockReturnValue(
      mockTelemetryWithTraces as TelemetryProvider,
    );

    const telemetryProvider =
      TelemetryManager.getProvider("cache-test-enabled");
    const cacheManagerWithTelemetry = new CacheManager({}, telemetryProvider);

    const config: CacheConfig = {
      enabled: true,
      cacheKey: ["telemetry-test"],
    };
    const interceptor = new CacheInterceptor(cacheManagerWithTelemetry, config);
    const fn = vi.fn().mockResolvedValue("result");

    const result = await interceptor.intercept(fn, context);

    // Verify the cache works correctly with telemetry
    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
