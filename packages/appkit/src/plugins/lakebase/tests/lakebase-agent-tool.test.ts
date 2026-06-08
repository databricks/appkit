import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Tests the agent-tool surface of the Lakebase plugin.
 *
 * The plugin defaults to **not** exposing an agent tool at all. Enabling the
 * tool is an explicit opt-in (`exposeAsAgentTool` with an acknowledgement
 * flag) because every invocation runs with the caller's execution context
 * (SP or per-user via RoutingPool).
 */

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

// Client calls recorded by the read-only-statement test. The `connect()`
// mock returns a fresh client whose `query` pushes to this array so tests
// can assert the exact sequence of statements emitted on the dedicated
// connection.
const clientQueries: Array<{ text: string; values?: unknown[] }> = [];
const clientReleases: number[] = [];

vi.mock("../../../connectors/lakebase", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../connectors/lakebase")>();
  return {
    ...actual,
    createLakebasePool: vi.fn(() => ({
      query: vi.fn(),
      connect: vi.fn(async () => {
        let releaseCalls = 0;
        return {
          query: vi.fn(async (text: string, values?: unknown[]) => {
            clientQueries.push({ text, values });
            return { rows: [{ n: 1 }] };
          }),
          release: vi.fn(() => {
            releaseCalls += 1;
            clientReleases.push(releaseCalls);
          }),
        };
      }),
      end: vi.fn(),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    })),
    createLakebasePoolManager: vi.fn(() => ({
      getPool: vi.fn(),
      hasPool: vi.fn(() => false),
      closeAll: vi.fn(async () => {}),
      size: 0,
    })),
    getLakebaseOrmConfig: vi.fn(() => ({})),
    getLakebasePgConfig: vi.fn(() => ({})),
    getUsernameWithApiLookup: vi.fn(async () => "test-user"),
  };
});

import type { Pool, PoolClient } from "pg";
import { LakebasePlugin } from "../lakebase";

function makePlugin(
  config: ConstructorParameters<typeof LakebasePlugin>[0],
): LakebasePlugin {
  return new LakebasePlugin(config);
}

describe("LakebasePlugin — agent tool opt-in", () => {
  test("does not register an agent tool by default", () => {
    const plugin = makePlugin({});
    expect(plugin.getAgentTools()).toEqual([]);
  });

  test("does not register a tool when `pool` is set but `exposeAsAgentTool` is absent", () => {
    const plugin = makePlugin({ pool: {} });
    expect(plugin.getAgentTools()).toEqual([]);
  });

  test("registers a read-only tool when opted in with defaults", () => {
    const plugin = makePlugin({
      exposeAsAgentTool: {},
    });
    const defs = plugin.getAgentTools();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("query");
    expect(defs[0].annotations).toEqual({
      effect: "read",
      idempotent: false,
      requiresUserContext: true,
    });
  });

  test("registers a destructive tool when readOnly: false is explicit", () => {
    const plugin = makePlugin({
      exposeAsAgentTool: { readOnly: false },
    });
    const defs = plugin.getAgentTools();
    expect(defs[0].annotations).toEqual({
      effect: "destructive",
      idempotent: false,
      requiresUserContext: true,
    });
  });
});

describe("LakebasePlugin — readOnly enforcement", () => {
  let plugin: LakebasePlugin;

  beforeEach(async () => {
    clientQueries.length = 0;
    clientReleases.length = 0;
    plugin = makePlugin({
      exposeAsAgentTool: {},
    });
    await plugin.setup();
  });

  test("rejects DROP before acquiring a client", async () => {
    await expect(
      plugin.executeAgentTool("query", { text: "DROP TABLE users" }),
    ).rejects.toThrow(/read-only policy violation/i);
    expect(clientQueries).toHaveLength(0);
  });

  test("rejects UPDATE, DELETE, INSERT", async () => {
    for (const text of [
      "UPDATE users SET email='x'",
      "DELETE FROM orders",
      "INSERT INTO x VALUES (1)",
    ]) {
      await expect(plugin.executeAgentTool("query", { text })).rejects.toThrow(
        /read-only policy violation/i,
      );
    }
    expect(clientQueries).toHaveLength(0);
  });

  test("runs SELECT inside BEGIN READ ONLY / ROLLBACK on a dedicated client", async () => {
    const rows = await plugin.executeAgentTool("query", {
      text: "SELECT * FROM users",
    });
    expect(rows).toEqual([{ n: 1 }]);
    expect(clientQueries.map((c) => c.text)).toEqual([
      "BEGIN READ ONLY",
      "SELECT * FROM users",
      "ROLLBACK",
    ]);
    // Client must be released exactly once, regardless of outcome.
    expect(clientReleases).toHaveLength(1);
  });

  test("forwards parameter values to the user statement only (the regression fix)", async () => {
    await plugin.executeAgentTool("query", {
      text: "SELECT * FROM users WHERE id = $1",
      values: [42],
    });
    expect(clientQueries).toEqual([
      { text: "BEGIN READ ONLY", values: undefined },
      { text: "SELECT * FROM users WHERE id = $1", values: [42] },
      { text: "ROLLBACK", values: undefined },
    ]);
  });

  test("releases the client even when the user statement throws", async () => {
    const { createLakebasePool } = await import("../../../connectors/lakebase");
    const fakeClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error("read-only violation"))
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(() => {
        clientReleases.push(clientReleases.length + 1);
      }),
    } as unknown as PoolClient;

    const poolFactory = vi.mocked(createLakebasePool);
    poolFactory.mockReturnValueOnce({
      query: vi.fn(),
      connect: vi.fn(async (): Promise<PoolClient> => fakeClient),
      end: vi.fn(),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    } as unknown as Pool);

    clientQueries.length = 0;
    clientReleases.length = 0;
    const leakyPlugin = makePlugin({
      exposeAsAgentTool: {},
    });
    await leakyPlugin.setup();

    await expect(
      leakyPlugin.executeAgentTool("query", {
        text: "SELECT * FROM users",
      }),
    ).rejects.toThrow(/read-only violation/);
    expect(clientReleases).toHaveLength(1);
  });
});

describe("LakebasePlugin — destructive mode", () => {
  test("does NOT wrap in read-only transaction when readOnly: false", async () => {
    const queryMock = vi.fn((_text: string, _values?: unknown[]) =>
      Promise.resolve({ rows: [] }),
    );
    const plugin = makePlugin({
      exposeAsAgentTool: { readOnly: false },
    });
    await plugin.setup();
    vi.spyOn(plugin, "query").mockImplementation(async (text, values) => {
      queryMock(text, values);
      return { rows: [] } as never;
    });

    await plugin.executeAgentTool("query", {
      text: "UPDATE t SET x=1 WHERE id=$1",
      values: [42],
    });

    expect(queryMock).toHaveBeenCalledWith(
      "UPDATE t SET x=1 WHERE id=$1",
      [42],
    );
  });
});

describe("LakebasePlugin — OBO via RoutingPool", () => {
  const userPoolQueries: Array<{ text: string; values?: unknown[] }> = [];
  const userClientQueries: Array<{ text: string; values?: unknown[] }> = [];

  function makeUserPool() {
    return {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        userPoolQueries.push({ text, values });
        return { rows: [{ from: "user-pool" }] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (text: string, values?: unknown[]) => {
          userClientQueries.push({ text, values });
          return { rows: [{ from: "user-pool-client" }] };
        }),
        release: vi.fn(),
      })),
      end: vi.fn(),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    };
  }

  beforeEach(async () => {
    userPoolQueries.length = 0;
    userClientQueries.length = 0;
    clientQueries.length = 0;

    const { createLakebasePoolManager } = await import(
      "../../../connectors/lakebase"
    );
    vi.mocked(createLakebasePoolManager).mockReturnValue({
      getPool: vi.fn(() => makeUserPool() as unknown as Pool),
      hasPool: vi.fn(() => false),
      closePool: vi.fn(async () => {}),
      closeAll: vi.fn(async () => {}),
      get size() {
        return 1;
      },
    });
  });

  test("read-only query routes to user pool inside runInUserContext", async () => {
    const { runInUserContext } = await import(
      "../../../context/execution-context"
    );
    const plugin = makePlugin({ exposeAsAgentTool: {} });
    await plugin.setup();

    const userCtx = {
      client: {} as any,
      userId: "user-123",
      userEmail: "alice@example.com",
      workspaceId: Promise.resolve("ws-1"),
      isUserContext: true as const,
    };

    const result = await runInUserContext(userCtx, () =>
      plugin.executeAgentTool("query", { text: "SELECT 1" }),
    );

    expect(result).toEqual([{ from: "user-pool-client" }]);
    expect(userClientQueries.map((c) => c.text)).toEqual([
      "BEGIN READ ONLY",
      "SELECT 1",
      "ROLLBACK",
    ]);
    // SP pool should NOT have been touched
    expect(clientQueries).toHaveLength(0);
  });

  test("destructive query routes to user pool inside runInUserContext", async () => {
    const { runInUserContext } = await import(
      "../../../context/execution-context"
    );

    const plugin = makePlugin({ exposeAsAgentTool: { readOnly: false } });
    await plugin.setup();

    const userCtx = {
      client: {} as any,
      userId: "user-123",
      userEmail: "alice@example.com",
      workspaceId: Promise.resolve("ws-1"),
      isUserContext: true as const,
    };

    const result = await runInUserContext(userCtx, () =>
      plugin.executeAgentTool("query", {
        text: "UPDATE t SET x=1",
        values: [42],
      }),
    );

    expect(result).toEqual([{ from: "user-pool" }]);
    expect(userPoolQueries).toEqual([
      { text: "UPDATE t SET x=1", values: [42] },
    ]);
    expect(clientQueries).toHaveLength(0);
  });

  test("read-only policy still enforced in user context", async () => {
    const { runInUserContext } = await import(
      "../../../context/execution-context"
    );

    const plugin = makePlugin({ exposeAsAgentTool: {} });
    await plugin.setup();

    const userCtx = {
      client: {} as any,
      userId: "user-123",
      workspaceId: Promise.resolve("ws-1"),
      isUserContext: true as const,
    };

    await expect(
      runInUserContext(userCtx, () =>
        plugin.executeAgentTool("query", { text: "DROP TABLE users" }),
      ),
    ).rejects.toThrow(/read-only policy violation/i);

    expect(userClientQueries).toHaveLength(0);
    expect(clientQueries).toHaveLength(0);
  });
});
