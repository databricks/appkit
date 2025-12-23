import type { CacheStorage } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CacheManager } from "../../index";

// Mock LakebaseConnector
const mockLakebaseHealthCheck = vi.fn();
vi.mock("@/connectors", () => ({
  LakebaseConnector: vi.fn().mockImplementation(() => ({
    healthCheck: mockLakebaseHealthCheck,
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock PersistentStorage
vi.mock("../storage/persistent", () => ({
  PersistentStorage: vi.fn().mockImplementation(() => {
    const cache = new Map<string, { value: unknown; expiry: number }>();
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      get: vi
        .fn()
        .mockImplementation(async (key: string) => cache.get(key) || null),
      set: vi
        .fn()
        .mockImplementation(async (key: string, entry: any) =>
          cache.set(key, entry),
        ),
      delete: vi
        .fn()
        .mockImplementation(async (key: string) => cache.delete(key)),
      clear: vi.fn().mockImplementation(async () => cache.clear()),
      has: vi.fn().mockImplementation(async (key: string) => cache.has(key)),
      size: vi.fn().mockImplementation(async () => cache.size),
      isPersistent: vi.fn().mockReturnValue(true),
      healthCheck: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
      cleanupExpired: vi.fn().mockResolvedValue(0),
    };
  }),
}));

// Mock WorkspaceClient
vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn().mockImplementation(() => ({})),
}));

/** Create a mock storage for testing */
function createMockStorage(persistent = false): CacheStorage {
  const cache = new Map<string, { value: unknown; expiry: number }>();

  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      return cache.get(key) || null;
    }),
    set: vi.fn().mockImplementation(async (key: string, entry: any) => {
      cache.set(key, entry);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      cache.delete(key);
    }),
    clear: vi.fn().mockImplementation(async () => {
      cache.clear();
    }),
    has: vi.fn().mockImplementation(async (key: string) => {
      return cache.has(key);
    }),
    size: vi.fn().mockImplementation(async () => {
      return cache.size;
    }),
    isPersistent: vi.fn().mockReturnValue(persistent),
    healthCheck: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock storage with healthCheck returning false */
function createUnhealthyMockStorage(): CacheStorage {
  const storage = createMockStorage();
  storage.healthCheck = vi.fn().mockResolvedValue(false);
  return storage;
}

describe("CacheManager", () => {
  // Reset singleton between tests
  beforeEach(() => {
    // Access private static fields to reset singleton
    (CacheManager as any).instance = null;
    (CacheManager as any).initPromise = null;
    // Default: Lakebase unavailable (most tests pass explicit storage)
    mockLakebaseHealthCheck.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("singleton pattern", () => {
    test("getInstanceSync should throw when not initialized", () => {
      expect(() => CacheManager.getInstanceSync()).toThrow(
        "CacheManager not initialized",
      );
    });

    test("getInstance should create singleton", async () => {
      const instance1 = await CacheManager.getInstance({
        storage: createMockStorage(),
      });
      const instance2 = await CacheManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    test("getInstanceSync should return instance after initialization", async () => {
      await CacheManager.getInstance({ storage: createMockStorage() });

      const instance = CacheManager.getInstanceSync();

      expect(instance).toBeInstanceOf(CacheManager);
    });
  });

  describe("generateKey", () => {
    test("should generate consistent hash for same inputs", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      const key1 = cache.generateKey(["users", 123], "user1");
      const key2 = cache.generateKey(["users", 123], "user1");

      expect(key1).toBe(key2);
    });

    test("should generate different hash for different inputs", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      const key1 = cache.generateKey(["users", 123], "user1");
      const key2 = cache.generateKey(["users", 456], "user1");
      const key3 = cache.generateKey(["users", 123], "user2");

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key2).not.toBe(key3);
    });

    test("should handle objects in key parts", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      const key1 = cache.generateKey([{ filter: "active" }], "user1");
      const key2 = cache.generateKey([{ filter: "active" }], "user1");
      const key3 = cache.generateKey([{ filter: "inactive" }], "user1");

      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });
  });

  describe("get/set operations", () => {
    test("should return null for non-existent key", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      const result = await cache.get("non-existent");

      expect(result).toBeNull();
    });

    test("should set and get value", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      await cache.set("test-key", { data: "test-value" });
      const result = await cache.get("test-key");

      expect(result).toEqual({ data: "test-value" });
    });

    test("should respect TTL expiry", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      // Set with very short TTL
      await cache.set("test-key", "value", { ttl: 0.001 }); // 1ms

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await cache.get("test-key");

      expect(result).toBeNull();
    });
  });

  describe("delete operation", () => {
    test("should delete existing key", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      await cache.set("test-key", "value");
      await cache.delete("test-key");

      const result = await cache.get("test-key");
      expect(result).toBeNull();
    });
  });

  describe("has operation", () => {
    test("should return true for existing key", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      await cache.set("test-key", "value");

      const exists = await cache.has("test-key");
      expect(exists).toBe(true);
    });

    test("should return false for non-existent key", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      const exists = await cache.has("non-existent");
      expect(exists).toBe(false);
    });

    test("should return false for expired key", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      await cache.set("test-key", "value", { ttl: 0.001 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const exists = await cache.has("test-key");
      expect(exists).toBe(false);
    });
  });

  describe("clear operation", () => {
    test("should clear all entries", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      await cache.set("key1", "value1");
      await cache.set("key2", "value2");

      await cache.clear();

      expect(await cache.get("key1")).toBeNull();
      expect(await cache.get("key2")).toBeNull();
    });
  });

  describe("getOrExecute", () => {
    test("should execute function on cache miss", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });
      const fn = vi.fn().mockResolvedValue("result");

      const result = await cache.getOrExecute(["key"], fn, "user1");

      expect(result).toBe("result");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("should return cached value on cache hit", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });
      const fn = vi.fn().mockResolvedValue("new-result");

      // First call - populates cache
      await cache.getOrExecute(["key"], async () => "cached-result", "user1");

      // Second call - should use cache
      const result = await cache.getOrExecute(["key"], fn, "user1");

      expect(result).toBe("cached-result");
      expect(fn).not.toHaveBeenCalled();
    });

    test("should deduplicate concurrent requests", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });
      let callCount = 0;
      const fn = vi.fn().mockImplementation(async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return `result-${callCount}`;
      });

      // Fire multiple concurrent requests
      const promises = [
        cache.getOrExecute(["key"], fn, "user1"),
        cache.getOrExecute(["key"], fn, "user1"),
        cache.getOrExecute(["key"], fn, "user1"),
      ];

      const results = await Promise.all(promises);

      // All should return same result
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
      // Function should only be called once
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("should use different cache keys for different users", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      await cache.getOrExecute(["key"], async () => "user1-data", "user1");
      await cache.getOrExecute(["key"], async () => "user2-data", "user2");

      const result1 = await cache.getOrExecute(
        ["key"],
        async () => "should-not-be-called",
        "user1",
      );
      const result2 = await cache.getOrExecute(
        ["key"],
        async () => "should-not-be-called",
        "user2",
      );

      expect(result1).toBe("user1-data");
      expect(result2).toBe("user2-data");
    });
  });

  describe("disabled cache", () => {
    test("should bypass cache when disabled", async () => {
      const cache = await CacheManager.getInstance({
        enabled: false,
        storage: createMockStorage(),
      });
      const fn = vi.fn().mockResolvedValue("result");

      const result1 = await cache.getOrExecute(["key"], fn, "user1");
      const result2 = await cache.getOrExecute(["key"], fn, "user1");

      expect(result1).toBe("result");
      expect(result2).toBe("result");
      expect(fn).toHaveBeenCalledTimes(2); // Called twice because cache is disabled
    });

    test("should return null for get when disabled", async () => {
      const cache = await CacheManager.getInstance({
        enabled: false,
        storage: createMockStorage(),
      });

      await cache.set("test-key", "value");
      const result = await cache.get("test-key");

      expect(result).toBeNull();
    });

    test("should return false for has when disabled", async () => {
      const cache = await CacheManager.getInstance({
        enabled: false,
        storage: createMockStorage(),
      });

      await cache.set("test-key", "value");
      const exists = await cache.has("test-key");

      expect(exists).toBe(false);
    });
  });

  describe("storage health", () => {
    test("should check storage health", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      const isHealthy = await cache.isStorageHealthy();

      expect(isHealthy).toBe(true);
    });
  });

  describe("close", () => {
    test("should close storage", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });

      await expect(cache.close()).resolves.not.toThrow();
    });
  });

  describe("maybeCleanup", () => {
    test("should not trigger cleanup for non-persistent storage", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(false),
        cleanupProbability: 1, // 100% probability
      });

      // Access private method via reflection
      const maybeCleanup = (cache as any).maybeCleanup.bind(cache);
      const storage = (cache as any).storage;

      maybeCleanup();

      // cleanupExpired should not exist on in-memory storage
      expect(storage.isPersistent()).toBe(false);
    });

    test("should respect MIN_CLEANUP_INTERVAL_MS", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
        cleanupProbability: 1,
      });

      // Simulate persistent storage
      const mockStorage = {
        isPersistent: vi.fn().mockReturnValue(true),
        cleanupExpired: vi.fn().mockResolvedValue(5),
      };
      (cache as any).storage = mockStorage;
      (cache as any).lastCleanupAttempt = Date.now(); // Just cleaned up

      const maybeCleanup = (cache as any).maybeCleanup.bind(cache);
      maybeCleanup();

      // Should not trigger cleanup due to interval
      expect(mockStorage.cleanupExpired).not.toHaveBeenCalled();
    });

    test("should trigger cleanup when probability allows and interval passed", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
        cleanupProbability: 1, // 100% probability
      });

      // Simulate persistent storage
      const mockStorage = {
        isPersistent: vi.fn().mockReturnValue(true),
        cleanupExpired: vi.fn().mockResolvedValue(5),
      };
      (cache as any).storage = mockStorage;
      (cache as any).lastCleanupAttempt = 0; // Long time ago

      const maybeCleanup = (cache as any).maybeCleanup.bind(cache);
      maybeCleanup();

      // Should trigger cleanup
      expect(mockStorage.cleanupExpired).toHaveBeenCalled();
    });

    test("should not trigger cleanup when already in progress", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
        cleanupProbability: 1,
      });

      const mockStorage = {
        isPersistent: vi.fn().mockReturnValue(true),
        cleanupExpired: vi.fn().mockResolvedValue(5),
      };
      (cache as any).storage = mockStorage;
      (cache as any).lastCleanupAttempt = 0;
      (cache as any).cleanupInProgress = true; // Already running

      const maybeCleanup = (cache as any).maybeCleanup.bind(cache);
      maybeCleanup();

      expect(mockStorage.cleanupExpired).not.toHaveBeenCalled();
    });

    test("should handle cleanup errors gracefully", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
        cleanupProbability: 1,
      });

      const mockStorage = {
        isPersistent: vi.fn().mockReturnValue(true),
        cleanupExpired: vi.fn().mockRejectedValue(new Error("Cleanup failed")),
      };
      (cache as any).storage = mockStorage;
      (cache as any).lastCleanupAttempt = 0;

      const maybeCleanup = (cache as any).maybeCleanup.bind(cache);

      // Should not throw
      expect(() => maybeCleanup()).not.toThrow();

      // Wait for async cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // cleanupInProgress should be reset
      expect((cache as any).cleanupInProgress).toBe(false);
    });
  });

  describe("getOrExecute error handling", () => {
    test("should propagate errors from executed function", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });
      const error = new Error("Execution failed");
      const fn = vi.fn().mockRejectedValue(error);

      await expect(cache.getOrExecute(["key"], fn, "user1")).rejects.toThrow(
        "Execution failed",
      );
    });

    test("should remove in-flight request on error", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });
      const error = new Error("Execution failed");
      const fn = vi.fn().mockRejectedValue(error);

      try {
        await cache.getOrExecute(["key"], fn, "user1");
      } catch {
        // Expected
      }

      // Verify in-flight request was cleaned up
      const cacheKey = cache.generateKey(["key"], "user1");
      expect((cache as any).inFlightRequests.has(cacheKey)).toBe(false);
    });

    test("should allow retry after error", async () => {
      const cache = await CacheManager.getInstance({
        storage: createMockStorage(),
      });
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("First attempt failed"))
        .mockResolvedValueOnce("success");

      // First call fails
      await expect(cache.getOrExecute(["key"], fn, "user1")).rejects.toThrow();

      // Second call succeeds
      const result = await cache.getOrExecute(["key"], fn, "user1");
      expect(result).toBe("success");
    });
  });

  describe("strictPersistence mode", () => {
    test("should disable cache when strictPersistence is true and storage unhealthy", async () => {
      // Reset singleton
      (CacheManager as any).instance = null;
      (CacheManager as any).initPromise = null;

      // Pass an unhealthy storage with strictPersistence: true
      const cache = await CacheManager.getInstance({
        storage: createUnhealthyMockStorage(),
        strictPersistence: true,
      });

      // Cache should be disabled
      const fn = vi.fn().mockResolvedValue("result");
      await cache.getOrExecute(["key"], fn, "user1");
      await cache.getOrExecute(["key"], fn, "user1");

      // Function called twice because cache is disabled
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("storage fallback", () => {
    test("should fallback to in-memory when provided storage is unhealthy", async () => {
      // Reset singleton
      (CacheManager as any).instance = null;
      (CacheManager as any).initPromise = null;

      // Pass an unhealthy storage, should fallback to in-memory
      const cache = await CacheManager.getInstance({
        storage: createUnhealthyMockStorage(),
        strictPersistence: false,
      });

      // Cache should still work (in-memory fallback)
      await cache.set("test-key", "value");
      const result = await cache.get("test-key");
      expect(result).toBe("value");
    });

    test("should use in-memory storage when provided storage health check fails", async () => {
      // Reset singleton
      (CacheManager as any).instance = null;
      (CacheManager as any).initPromise = null;

      const cache = await CacheManager.getInstance({
        storage: createUnhealthyMockStorage(),
        strictPersistence: false,
      });

      // Should be using in-memory storage (not persistent)
      const storage = (cache as any).storage;
      expect(storage.isPersistent()).toBe(false);
    });
  });

  describe("lakebase default storage", () => {
    test("should use Lakebase when no storage provided and Lakebase is available", async () => {
      // Reset singleton
      (CacheManager as any).instance = null;
      (CacheManager as any).initPromise = null;

      // Make Lakebase healthy
      mockLakebaseHealthCheck.mockResolvedValue(true);

      const cache = await CacheManager.getInstance({});

      // Storage should be persistent (Lakebase)
      const storage = (cache as any).storage;
      expect(storage.isPersistent()).toBe(true);
    });

    test("should fallback to in-memory when Lakebase is unavailable", async () => {
      // Reset singleton
      (CacheManager as any).instance = null;
      (CacheManager as any).initPromise = null;

      // Lakebase unhealthy (default in beforeEach)
      mockLakebaseHealthCheck.mockResolvedValue(false);

      const cache = await CacheManager.getInstance({});

      // Cache should work (in-memory fallback)
      await cache.set("test-key", "value");
      const result = await cache.get("test-key");
      expect(result).toBe("value");

      // Storage should not be persistent
      const storage = (cache as any).storage;
      expect(storage.isPersistent()).toBe(false);
    });

    test("should disable cache when Lakebase unavailable and strictPersistence is true", async () => {
      // Reset singleton
      (CacheManager as any).instance = null;
      (CacheManager as any).initPromise = null;

      // Lakebase unhealthy
      mockLakebaseHealthCheck.mockResolvedValue(false);

      const cache = await CacheManager.getInstance({
        strictPersistence: true,
      });

      // Cache should be disabled
      const fn = vi.fn().mockResolvedValue("result");
      await cache.getOrExecute(["key"], fn, "user1");
      await cache.getOrExecute(["key"], fn, "user1");

      // Function called twice because cache is disabled
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test("should use in-memory storage when Lakebase health check fails", async () => {
      // Reset singleton
      (CacheManager as any).instance = null;
      (CacheManager as any).initPromise = null;

      // Lakebase unhealthy
      mockLakebaseHealthCheck.mockResolvedValue(false);

      const cache = await CacheManager.getInstance({});

      // Should be using in-memory storage
      const storage = (cache as any).storage;
      expect(storage.isPersistent()).toBe(false);
    });

    test("should use in-memory storage when Lakebase throws an error", async () => {
      // Reset singleton
      (CacheManager as any).instance = null;
      (CacheManager as any).initPromise = null;

      // Lakebase throws
      mockLakebaseHealthCheck.mockRejectedValue(
        new Error("Connection refused"),
      );

      const cache = await CacheManager.getInstance({});

      // Should be using in-memory storage
      const storage = (cache as any).storage;
      expect(storage.isPersistent()).toBe(false);
    });
  });
});
