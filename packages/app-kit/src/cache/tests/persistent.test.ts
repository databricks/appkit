import { beforeEach, describe, expect, test, vi } from "vitest";
import { PersistentStorage } from "../storage";

/** Mock LakebaseConnector for testing */
const createMockConnector = () => ({
  query: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(undefined),
});

describe("PersistentStorage", () => {
  let storage: PersistentStorage;
  let mockConnector: ReturnType<typeof createMockConnector>;

  beforeEach(() => {
    mockConnector = createMockConnector();

    // Default: migrations succeed
    mockConnector.query.mockResolvedValue({ rows: [] });

    storage = new PersistentStorage(
      { maxBytes: 1024 * 1024 }, // 1MB
      mockConnector as any,
    );
  });

  describe("initialization", () => {
    test("should run migrations on initialize", async () => {
      await storage.initialize();

      // Should create table
      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE IF NOT EXISTS"),
      );

      // Should create unique index on key_hash
      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("CREATE UNIQUE INDEX IF NOT EXISTS"),
      );
    });

    test("should only initialize once", async () => {
      await storage.initialize();
      await storage.initialize();

      // CREATE TABLE should only be called once (first initialization)
      const createTableCalls = mockConnector.query.mock.calls.filter((call) =>
        call[0].includes("CREATE TABLE"),
      );
      expect(createTableCalls.length).toBe(1);
    });

    test("should throw on migration error", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      mockConnector.query.mockRejectedValue(new Error("migration failed"));

      await expect(storage.initialize()).rejects.toThrow("migration failed");

      consoleErrorSpy.mockRestore();
    });
  });

  describe("get", () => {
    beforeEach(async () => {
      await storage.initialize();
      mockConnector.query.mockClear();
    });

    test("should return cached entry", async () => {
      const expiry = Date.now() + 10000;
      const valueBuffer = Buffer.from(
        JSON.stringify({ data: "test" }),
        "utf-8",
      );

      mockConnector.query.mockResolvedValueOnce({
        rows: [{ value: valueBuffer, expiry: String(expiry) }],
      });

      const result = await storage.get("test-key");

      expect(result).toEqual({
        value: { data: "test" },
        expiry,
      });
      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT value, expiry"),
        [expect.any(BigInt)], // key_hash is bigint
      );
    });

    test("should return null for non-existent key", async () => {
      mockConnector.query.mockResolvedValueOnce({ rows: [] });

      const result = await storage.get("non-existent");

      expect(result).toBeNull();
    });

    test("should update last_accessed on get (fire-and-forget)", async () => {
      const expiry = Date.now() + 10000;
      const valueBuffer = Buffer.from(
        JSON.stringify({ data: "test" }),
        "utf-8",
      );

      mockConnector.query
        .mockResolvedValueOnce({
          rows: [{ value: valueBuffer, expiry: String(expiry) }],
        })
        .mockResolvedValue({ rows: [] });

      await storage.get("test-key");

      // Wait for fire-and-forget update
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE"),
        [expect.any(BigInt)], // key_hash
      );
    });
  });

  describe("set", () => {
    beforeEach(async () => {
      await storage.initialize();
      mockConnector.query.mockClear();
    });

    test("should insert new entry", async () => {
      // totalBytes() returns 0
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ total: "0" }],
      });
      // INSERT succeeds
      mockConnector.query.mockResolvedValueOnce({ rows: [] });

      await storage.set("test-key", {
        value: { data: "test" },
        expiry: Date.now() + 10000,
      });

      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO"),
        expect.arrayContaining([
          expect.any(BigInt), // key_hash
          expect.any(Buffer), // key
          expect.any(Buffer), // value
          expect.any(Number), // byte_size
          expect.any(Number), // expiry
        ]),
      );
    });

    test("should evict when maxBytes exceeded", async () => {
      // totalBytes() returns maxBytes (triggers eviction)
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ total: String(1024 * 1024) }], // 1MB (at limit)
      });
      // cleanupExpired returns 0
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ count: "0" }],
      });
      // eviction DELETE succeeds
      mockConnector.query.mockResolvedValueOnce({ rows: [] });
      // INSERT succeeds
      mockConnector.query.mockResolvedValueOnce({ rows: [] });

      await storage.set("new-key", {
        value: { data: "new" },
        expiry: Date.now() + 10000,
      });

      // Should have called DELETE for LRU eviction
      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM"),
        expect.any(Array),
      );
    });

    test("should serialize value to Buffer", async () => {
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ total: "0" }],
      });
      mockConnector.query.mockResolvedValueOnce({ rows: [] });

      const value = { nested: { array: [1, 2, 3] } };
      await storage.set("test-key", {
        value,
        expiry: Date.now() + 10000,
      });

      const insertCall = mockConnector.query.mock.calls.find((call) =>
        call[0].includes("INSERT"),
      );

      // value is at index 2 (key_hash, key, value, ...)
      const valueBuffer = insertCall?.[1]?.[2] as Buffer;
      expect(valueBuffer).toBeInstanceOf(Buffer);
      expect(valueBuffer.toString("utf-8")).toBe(JSON.stringify(value));
    });
  });

  describe("delete", () => {
    beforeEach(async () => {
      await storage.initialize();
      mockConnector.query.mockClear();
    });

    test("should delete entry by key_hash", async () => {
      mockConnector.query.mockResolvedValueOnce({ rows: [] });

      await storage.delete("test-key");

      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM"),
        [expect.any(BigInt)], // key_hash
      );
    });
  });

  describe("clear", () => {
    beforeEach(async () => {
      await storage.initialize();
      mockConnector.query.mockClear();
    });

    test("should truncate table", async () => {
      mockConnector.query.mockResolvedValueOnce({ rows: [] });

      await storage.clear();

      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("TRUNCATE TABLE"),
      );
    });
  });

  describe("has", () => {
    beforeEach(async () => {
      await storage.initialize();
      mockConnector.query.mockClear();
    });

    test("should return true when key exists", async () => {
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ exists: true }],
      });

      const result = await storage.has("test-key");

      expect(result).toBe(true);
      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT EXISTS"),
        [expect.any(BigInt)], // key_hash
      );
    });

    test("should return false when key does not exist", async () => {
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ exists: false }],
      });

      const result = await storage.has("non-existent");

      expect(result).toBe(false);
    });

    test("should return false when query returns no rows", async () => {
      mockConnector.query.mockResolvedValueOnce({ rows: [] });

      const result = await storage.has("test-key");

      expect(result).toBe(false);
    });
  });

  describe("size", () => {
    beforeEach(async () => {
      await storage.initialize();
      mockConnector.query.mockClear();
    });

    test("should return count of entries", async () => {
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ count: "42" }],
      });

      const result = await storage.size();

      expect(result).toBe(42);
    });

    test("should return 0 when empty", async () => {
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ count: "0" }],
      });

      const result = await storage.size();

      expect(result).toBe(0);
    });

    test("should return 0 when no rows", async () => {
      mockConnector.query.mockResolvedValueOnce({ rows: [] });

      const result = await storage.size();

      expect(result).toBe(0);
    });
  });

  describe("totalBytes", () => {
    beforeEach(async () => {
      await storage.initialize();
      mockConnector.query.mockClear();
    });

    test("should return sum of byte_size", async () => {
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ total: "1048576" }], // 1MB
      });

      const result = await storage.totalBytes();

      expect(result).toBe(1048576);
    });

    test("should return 0 when empty", async () => {
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ total: "0" }],
      });

      const result = await storage.totalBytes();

      expect(result).toBe(0);
    });
  });

  describe("cleanupExpired", () => {
    beforeEach(async () => {
      await storage.initialize();
      mockConnector.query.mockClear();
    });

    test("should delete expired entries", async () => {
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ count: "5" }],
      });

      const deleted = await storage.cleanupExpired();

      expect(deleted).toBe(5);
      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM"),
        expect.arrayContaining([expect.any(Number)]),
      );
    });

    test("should return 0 when no expired entries", async () => {
      mockConnector.query.mockResolvedValueOnce({
        rows: [{ count: "0" }],
      });

      const deleted = await storage.cleanupExpired();

      expect(deleted).toBe(0);
    });
  });

  describe("storage properties", () => {
    test("should report as persistent", () => {
      expect(storage.isPersistent()).toBe(true);
    });

    test("should delegate healthCheck to connector", async () => {
      mockConnector.healthCheck.mockResolvedValueOnce(true);

      const result = await storage.healthCheck();

      expect(result).toBe(true);
      expect(mockConnector.healthCheck).toHaveBeenCalled();
    });

    test("should return false on healthCheck error", async () => {
      mockConnector.healthCheck.mockRejectedValueOnce(new Error("failed"));

      const result = await storage.healthCheck();

      expect(result).toBe(false);
    });

    test("should close connector on close", async () => {
      await storage.close();

      expect(mockConnector.close).toHaveBeenCalled();
    });
  });

  describe("auto-initialization", () => {
    test("should auto-initialize on get if not initialized", async () => {
      const uninitializedStorage = new PersistentStorage(
        { maxBytes: 1024 * 1024 },
        mockConnector as any,
      );

      mockConnector.query.mockResolvedValue({ rows: [] });

      await uninitializedStorage.get("test-key");

      // Should have run migrations
      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE"),
      );
    });

    test("should auto-initialize on set if not initialized", async () => {
      const uninitializedStorage = new PersistentStorage(
        { maxBytes: 1024 * 1024 },
        mockConnector as any,
      );

      mockConnector.query.mockResolvedValue({ rows: [] });

      await uninitializedStorage.set("test-key", {
        value: "test",
        expiry: Date.now() + 10000,
      });

      // Should have run migrations
      expect(mockConnector.query).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE"),
      );
    });
  });
});
