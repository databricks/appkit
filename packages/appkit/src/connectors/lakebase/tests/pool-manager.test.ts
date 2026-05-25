import type { Pool } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(
        async (_k: unknown[], fn: (signal?: AbortSignal) => Promise<unknown>) =>
          fn(),
      ),
      generateKey: vi.fn(() => "test-key"),
    })),
  },
}));

const mockPools: Pool[] = [];

vi.mock("../index", () => ({
  createLakebasePool: vi.fn(() => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(),
      end: vi.fn(async () => {}),
      totalCount: 1,
      idleCount: 0,
      waitingCount: 0,
    } as unknown as Pool;
    mockPools.push(pool);
    return pool;
  }),
}));

import { createLakebasePoolManager } from "../pool-manager";

afterEach(() => {
  mockPools.length = 0;
  vi.restoreAllMocks();
});

describe("createLakebasePoolManager", () => {
  test("creates and caches a pool for a key", () => {
    const manager = createLakebasePoolManager();
    const pool1 = manager.getPool("user-a", { user: "user-a" });
    const pool2 = manager.getPool("user-a", { user: "user-a" });

    expect(pool1).toBe(pool2);
    expect(mockPools).toHaveLength(1);
    expect(manager.size).toBe(1);
  });

  test("creates separate pools for different keys", () => {
    const manager = createLakebasePoolManager();
    const poolA = manager.getPool("user-a", { user: "user-a" });
    const poolB = manager.getPool("user-b", { user: "user-b" });

    expect(poolA).not.toBe(poolB);
    expect(mockPools).toHaveLength(2);
    expect(manager.size).toBe(2);
  });

  test("hasPool returns correct state", () => {
    const manager = createLakebasePoolManager();

    expect(manager.hasPool("user-a")).toBe(false);
    manager.getPool("user-a", { user: "user-a" });
    expect(manager.hasPool("user-a")).toBe(true);
  });

  test("closePool closes and removes a specific pool", async () => {
    const manager = createLakebasePoolManager();
    const pool = manager.getPool("user-a", { user: "user-a" });

    await manager.closePool("user-a");

    expect(pool.end).toHaveBeenCalled();
    expect(manager.hasPool("user-a")).toBe(false);
    expect(manager.size).toBe(0);
  });

  test("closePool is a no-op for unknown keys", async () => {
    const manager = createLakebasePoolManager();
    await manager.closePool("nonexistent");
    expect(manager.size).toBe(0);
  });

  test("closeAll closes all pools and clears the map", async () => {
    const manager = createLakebasePoolManager();
    manager.getPool("user-a", { user: "user-a" });
    manager.getPool("user-b", { user: "user-b" });

    await manager.closeAll();

    expect(mockPools[0].end).toHaveBeenCalled();
    expect(mockPools[1].end).toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  test("getPool after closeAll creates a fresh pool", async () => {
    const manager = createLakebasePoolManager();
    const first = manager.getPool("user-a", { user: "user-a" });

    await manager.closeAll();
    const second = manager.getPool("user-a", { user: "user-a" });

    expect(second).not.toBe(first);
    expect(manager.size).toBe(1);
  });

  test("returns cached pool when tokenFingerprint matches", () => {
    const manager = createLakebasePoolManager();
    const pool1 = manager.getPool("user-a", { user: "user-a" }, "fp-aaa");
    const pool2 = manager.getPool("user-a", { user: "user-a" }, "fp-aaa");

    expect(pool1).toBe(pool2);
    expect(mockPools).toHaveLength(1);
  });

  test("rebuilds pool when tokenFingerprint changes", () => {
    const manager = createLakebasePoolManager();
    const pool1 = manager.getPool("user-a", { user: "user-a" }, "fp-aaa");
    const pool2 = manager.getPool("user-a", { user: "user-a" }, "fp-bbb");

    expect(pool2).not.toBe(pool1);
    expect(pool1.end).toHaveBeenCalled();
    expect(mockPools).toHaveLength(2);
    expect(manager.size).toBe(1);
  });

  test("returns cached pool when no tokenFingerprint is provided", () => {
    const manager = createLakebasePoolManager();
    const pool1 = manager.getPool("user-a", { user: "user-a" });
    const pool2 = manager.getPool("user-a", { user: "user-a" });

    expect(pool1).toBe(pool2);
    expect(mockPools).toHaveLength(1);
  });
});
