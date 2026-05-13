import type { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";
import { RoutingPool } from "../routing-pool";

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(async (_k: unknown[], fn: () => Promise<unknown>) =>
        fn(),
      ),
      generateKey: vi.fn(() => "test-key"),
    })),
  },
}));

function makeMockPool(label: string) {
  return {
    query: vi.fn(async () => ({ rows: [{ source: label }] })),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [{ source: `${label}-client` }] })),
      release: vi.fn(),
    })),
    end: vi.fn(async () => {}),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0,
  } as unknown as Pool;
}

describe("RoutingPool", () => {
  test("routes to SP pool when no user context is active", async () => {
    const spPool = makeMockPool("sp");
    const userPool = makeMockPool("user");
    const pool = new RoutingPool(spPool, () => userPool);

    const result = await pool.query("SELECT 1");

    expect(result.rows).toEqual([{ source: "sp" }]);
    expect(spPool.query).toHaveBeenCalledWith("SELECT 1", undefined);
    expect(userPool.query).not.toHaveBeenCalled();
  });

  test("routes to user pool inside runInUserContext", async () => {
    const { runInUserContext } = await import(
      "../../../context/execution-context"
    );

    const spPool = makeMockPool("sp");
    const userPool = makeMockPool("user");
    const resolveUserPool = vi.fn(() => userPool);
    const pool = new RoutingPool(spPool, resolveUserPool);

    const userCtx = {
      client: {} as any,
      userId: "user-1",
      workspaceId: Promise.resolve("ws-1"),
      isUserContext: true as const,
    };
    const result = await runInUserContext(userCtx, () =>
      pool.query("SELECT 1"),
    );

    expect(result.rows).toEqual([{ source: "user" }]);
    expect(userPool.query).toHaveBeenCalledWith("SELECT 1", undefined);
    expect(spPool.query).not.toHaveBeenCalled();
    expect(resolveUserPool).toHaveBeenCalledWith(userCtx);
  });

  test("connect() routes to user pool inside runInUserContext", async () => {
    const { runInUserContext } = await import(
      "../../../context/execution-context"
    );

    const spPool = makeMockPool("sp");
    const userPool = makeMockPool("user");
    const pool = new RoutingPool(spPool, () => userPool);

    const userCtx = {
      client: {} as any,
      userId: "user-1",
      workspaceId: Promise.resolve("ws-1"),
      isUserContext: true as const,
    };
    const client = await runInUserContext(userCtx, () => pool.connect());

    expect(userPool.connect).toHaveBeenCalled();
    expect(spPool.connect).not.toHaveBeenCalled();
    expect(client).toBeDefined();
  });

  test("forwards query values to user pool inside runInUserContext", async () => {
    const { runInUserContext } = await import(
      "../../../context/execution-context"
    );

    const spPool = makeMockPool("sp");
    const userPool = makeMockPool("user");
    const pool = new RoutingPool(spPool, () => userPool);

    const userCtx = {
      client: {} as any,
      userId: "user-1",
      workspaceId: Promise.resolve("ws-1"),
      isUserContext: true as const,
    };
    await runInUserContext(userCtx, () =>
      pool.query("SELECT * FROM t WHERE id = $1", [42]),
    );

    expect(userPool.query).toHaveBeenCalledWith(
      "SELECT * FROM t WHERE id = $1",
      [42],
    );
    expect(spPool.query).not.toHaveBeenCalled();
  });

  test("end() closes SP pool", async () => {
    const spPool = makeMockPool("sp");
    const pool = new RoutingPool(spPool, () => makeMockPool("user"));

    await pool.end();

    expect(spPool.end).toHaveBeenCalled();
  });

  test("forwards monitoring properties from SP pool", () => {
    const spPool = makeMockPool("sp");
    const pool = new RoutingPool(spPool, () => makeMockPool("user"));

    expect(pool.totalCount).toBe(5);
    expect(pool.idleCount).toBe(3);
    expect(pool.waitingCount).toBe(0);
  });
});
