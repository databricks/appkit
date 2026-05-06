import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Tests the agent-tool surface of the Lakebase plugin.
 *
 * The plugin defaults to **not** exposing an agent tool at all. Enabling the
 * tool is an explicit opt-in (`exposeAsAgentTool` with an acknowledgement
 * flag) because every invocation runs with the application's service-
 * principal credentials regardless of which end user initiated the request.
 */

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

// Client calls recorded by the read-only-statement test. The `connect()`
// mock returns a fresh client whose `query` pushes to this array so tests
// can assert the exact sequence of statements emitted on the dedicated
// connection.
const clientQueries: Array<{ text: string; values?: unknown[] }> = [];
const clientReleases: number[] = [];

vi.mock("../../../connectors/lakebase", () => ({
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
  })),
  getLakebaseOrmConfig: vi.fn(() => ({})),
  getLakebasePgConfig: vi.fn(() => ({})),
  getUsernameWithApiLookup: vi.fn(async () => "test-user"),
}));

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
      readOnly: true,
      destructive: false,
      idempotent: false,
    });
  });

  test("registers a destructive tool when readOnly: false is explicit", () => {
    const plugin = makePlugin({
      exposeAsAgentTool: { readOnly: false },
    });
    const defs = plugin.getAgentTools();
    expect(defs[0].annotations).toEqual({
      readOnly: false,
      destructive: true,
      idempotent: false,
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
    // Prior to the fix this would have failed with "cannot insert multiple
    // commands into a prepared statement" because pg's Extended Query
    // protocol rejects multi-statement batches when values are supplied.
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
    // Poison the client so the middle query throws (simulates a Postgres
    // error like "cannot execute UPDATE in a read-only transaction").
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
