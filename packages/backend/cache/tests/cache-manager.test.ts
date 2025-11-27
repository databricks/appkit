import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CacheManager } from "../src/index";
import type { CacheStorage } from "../src/storage/types";

// Mock the storage modules
vi.mock("../src/storage/memory", () => ({
  InMemoryStorage: vi.fn().mockImplementation(() => createMockStorage()),
}));

vi.mock("../src/storage/persistent", () => ({
  PersistentStorage: vi.fn().mockImplementation(() => {
    const storage = createMockStorage();
    storage.isPersistent = vi.fn().mockReturnValue(true);
    return storage;
  }),
}));

// Mock LakebaseConnector
vi.mock("@databricks-apps/connectors", () => ({
  LakebaseConnector: vi.fn().mockImplementation(() => ({
    healthCheck: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock WorkspaceClient
vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn().mockImplementation(() => ({})),
}));

/** Create a mock storage for testing */
function createMockStorage(): CacheStorage {
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
    isPersistent: vi.fn().mockReturnValue(false),
    healthCheck: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CacheManager", () => {
  // Reset singleton between tests
  beforeEach(() => {
    // Access private static fields to reset singleton
    (CacheManager as any).instance = null;
    (CacheManager as any).initPromise = null;
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
        persistentCache: false,
      });
      const instance2 = await CacheManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    test("getInstanceSync should return instance after initialization", async () => {
      await CacheManager.getInstance({ persistentCache: false });

      const instance = CacheManager.getInstanceSync();

      expect(instance).toBeInstanceOf(CacheManager);
    });
  });

  describe("generateKey", () => {
    test("should generate consistent hash for same inputs", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      const key1 = cache.generateKey(["users", 123], "user1");
      const key2 = cache.generateKey(["users", 123], "user1");

      expect(key1).toBe(key2);
    });

    test("should generate different hash for different inputs", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      const key1 = cache.generateKey(["users", 123], "user1");
      const key2 = cache.generateKey(["users", 456], "user1");
      const key3 = cache.generateKey(["users", 123], "user2");

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key2).not.toBe(key3);
    });

    test("should handle objects in key parts", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      const key1 = cache.generateKey([{ filter: "active" }], "user1");
      const key2 = cache.generateKey([{ filter: "active" }], "user1");
      const key3 = cache.generateKey([{ filter: "inactive" }], "user1");

      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });
  });

  describe("get/set operations", () => {
    test("should return null for non-existent key", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      const result = await cache.get("non-existent");

      expect(result).toBeNull();
    });

    test("should set and get value", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      await cache.set("test-key", { data: "test-value" });
      const result = await cache.get("test-key");

      expect(result).toEqual({ data: "test-value" });
    });

    test("should respect TTL expiry", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

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
      const cache = await CacheManager.getInstance({ persistentCache: false });

      await cache.set("test-key", "value");
      await cache.delete("test-key");

      const result = await cache.get("test-key");
      expect(result).toBeNull();
    });
  });

  describe("has operation", () => {
    test("should return true for existing key", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      await cache.set("test-key", "value");

      const exists = await cache.has("test-key");
      expect(exists).toBe(true);
    });

    test("should return false for non-existent key", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      const exists = await cache.has("non-existent");
      expect(exists).toBe(false);
    });

    test("should return false for expired key", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      await cache.set("test-key", "value", { ttl: 0.001 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const exists = await cache.has("test-key");
      expect(exists).toBe(false);
    });
  });

  describe("clear operation", () => {
    test("should clear all entries", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      await cache.set("key1", "value1");
      await cache.set("key2", "value2");

      await cache.clear();

      expect(await cache.get("key1")).toBeNull();
      expect(await cache.get("key2")).toBeNull();
    });
  });

  describe("getOrExecute", () => {
    test("should execute function on cache miss", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });
      const fn = vi.fn().mockResolvedValue("result");

      const result = await cache.getOrExecute(["key"], fn, "user1");

      expect(result).toBe("result");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("should return cached value on cache hit", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });
      const fn = vi.fn().mockResolvedValue("new-result");

      // First call - populates cache
      await cache.getOrExecute(["key"], async () => "cached-result", "user1");

      // Second call - should use cache
      const result = await cache.getOrExecute(["key"], fn, "user1");

      expect(result).toBe("cached-result");
      expect(fn).not.toHaveBeenCalled();
    });

    test("should deduplicate concurrent requests", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });
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
      const cache = await CacheManager.getInstance({ persistentCache: false });

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
        persistentCache: false,
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
        persistentCache: false,
      });

      await cache.set("test-key", "value");
      const result = await cache.get("test-key");

      expect(result).toBeNull();
    });

    test("should return false for has when disabled", async () => {
      const cache = await CacheManager.getInstance({
        enabled: false,
        persistentCache: false,
      });

      await cache.set("test-key", "value");
      const exists = await cache.has("test-key");

      expect(exists).toBe(false);
    });
  });

  describe("storage health", () => {
    test("should check storage health", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      const isHealthy = await cache.isStorageHealthy();

      expect(isHealthy).toBe(true);
    });
  });

  describe("close", () => {
    test("should close storage", async () => {
      const cache = await CacheManager.getInstance({ persistentCache: false });

      await expect(cache.close()).resolves.not.toThrow();
    });
  });
});
