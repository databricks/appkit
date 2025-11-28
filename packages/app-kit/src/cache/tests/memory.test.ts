import { beforeEach, describe, expect, test } from "vitest";
import { InMemoryStorage } from "../storage";

describe("InMemoryStorage", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage({ maxSize: 5 });
  });

  describe("basic operations", () => {
    test("should set and get a value", async () => {
      const entry = { value: "test-value", expiry: Date.now() + 10000 };
      await storage.set("key1", entry);

      const result = await storage.get("key1");

      expect(result).toEqual(entry);
    });

    test("should return null for non-existent key", async () => {
      const result = await storage.get("non-existent");

      expect(result).toBeNull();
    });

    test("should delete a value", async () => {
      const entry = { value: "test-value", expiry: Date.now() + 10000 };
      await storage.set("key1", entry);

      await storage.delete("key1");

      const result = await storage.get("key1");
      expect(result).toBeNull();
    });

    test("should check if key exists", async () => {
      const entry = { value: "test-value", expiry: Date.now() + 10000 };
      await storage.set("key1", entry);

      expect(await storage.has("key1")).toBe(true);
      expect(await storage.has("non-existent")).toBe(false);
    });

    test("should return correct size", async () => {
      expect(await storage.size()).toBe(0);

      await storage.set("key1", { value: "v1", expiry: Date.now() + 10000 });
      expect(await storage.size()).toBe(1);

      await storage.set("key2", { value: "v2", expiry: Date.now() + 10000 });
      expect(await storage.size()).toBe(2);
    });

    test("should clear all entries", async () => {
      await storage.set("key1", { value: "v1", expiry: Date.now() + 10000 });
      await storage.set("key2", { value: "v2", expiry: Date.now() + 10000 });

      await storage.clear();

      expect(await storage.size()).toBe(0);
      expect(await storage.get("key1")).toBeNull();
      expect(await storage.get("key2")).toBeNull();
    });
  });

  describe("expiry handling", () => {
    test("should return entry if not expired", async () => {
      const entry = { value: "test-value", expiry: Date.now() + 10000 };
      await storage.set("key1", entry);

      const result = await storage.get("key1");

      expect(result).toEqual(entry);
    });

    test("should return expired entry on get (expiry check is done by CacheManager)", async () => {
      const entry = { value: "test-value", expiry: Date.now() - 1000 };
      await storage.set("key1", entry);

      // InMemoryStorage.get() returns the entry even if expired
      // The expiry check is done by CacheManager
      const result = await storage.get("key1");
      expect(result).toEqual(entry);
    });

    test("should return false for expired key on has()", async () => {
      const entry = { value: "test-value", expiry: Date.now() - 1000 };
      await storage.set("key1", entry);

      const exists = await storage.has("key1");

      expect(exists).toBe(false);
    });

    test("should delete expired entry when checking has()", async () => {
      const entry = { value: "test-value", expiry: Date.now() - 1000 };
      await storage.set("key1", entry);

      await storage.has("key1");

      // Entry should be deleted after has() check
      expect(await storage.size()).toBe(0);
    });
  });

  describe("LRU eviction", () => {
    test("should evict least recently used entry when full", async () => {
      // Fill storage to capacity (maxSize = 5)
      for (let i = 1; i <= 5; i++) {
        await storage.set(`key${i}`, {
          value: `value${i}`,
          expiry: Date.now() + 10000,
        });
      }

      expect(await storage.size()).toBe(5);

      // Add one more entry, should evict key1 (least recently used)
      await storage.set("key6", {
        value: "value6",
        expiry: Date.now() + 10000,
      });

      expect(await storage.size()).toBe(5);
      expect(await storage.get("key1")).toBeNull(); // evicted
      expect(await storage.get("key6")).not.toBeNull(); // new entry exists
    });

    test("should update access order on get", async () => {
      // Fill storage
      for (let i = 1; i <= 5; i++) {
        await storage.set(`key${i}`, {
          value: `value${i}`,
          expiry: Date.now() + 10000,
        });
      }

      // Access key1 to make it recently used
      await storage.get("key1");

      // Add new entry, should evict key2 (now least recently used)
      await storage.set("key6", {
        value: "value6",
        expiry: Date.now() + 10000,
      });

      expect(await storage.get("key1")).not.toBeNull(); // still exists (was accessed)
      expect(await storage.get("key2")).toBeNull(); // evicted
    });

    test("should update access order on set (existing key)", async () => {
      // Fill storage
      for (let i = 1; i <= 5; i++) {
        await storage.set(`key${i}`, {
          value: `value${i}`,
          expiry: Date.now() + 10000,
        });
      }

      // Update key1 to make it recently used
      await storage.set("key1", {
        value: "updated-value1",
        expiry: Date.now() + 10000,
      });

      // Add new entry, should evict key2 (now least recently used)
      await storage.set("key6", {
        value: "value6",
        expiry: Date.now() + 10000,
      });

      expect(await storage.get("key1")).not.toBeNull(); // still exists (was updated)
      expect(await storage.get("key2")).toBeNull(); // evicted
    });

    test("should not evict when updating existing key", async () => {
      // Fill storage
      for (let i = 1; i <= 5; i++) {
        await storage.set(`key${i}`, {
          value: `value${i}`,
          expiry: Date.now() + 10000,
        });
      }

      // Update existing key should not trigger eviction
      await storage.set("key3", {
        value: "updated-value3",
        expiry: Date.now() + 10000,
      });

      expect(await storage.size()).toBe(5);
      // All keys should still exist
      for (let i = 1; i <= 5; i++) {
        expect(await storage.get(`key${i}`)).not.toBeNull();
      }
    });
  });

  describe("storage properties", () => {
    test("should report as non-persistent", () => {
      expect(storage.isPersistent()).toBe(false);
    });

    test("should always return true for healthCheck", async () => {
      expect(await storage.healthCheck()).toBe(true);
    });

    test("should clear storage on close", async () => {
      await storage.set("key1", { value: "v1", expiry: Date.now() + 10000 });

      await storage.close();

      expect(await storage.size()).toBe(0);
    });
  });

  describe("default maxSize", () => {
    test("should use default maxSize when not provided", async () => {
      const defaultStorage = new InMemoryStorage({});

      // Default is 1000, just verify it accepts many entries
      for (let i = 1; i <= 100; i++) {
        await defaultStorage.set(`key${i}`, {
          value: `value${i}`,
          expiry: Date.now() + 10000,
        });
      }

      expect(await defaultStorage.size()).toBe(100);
    });
  });
});
