import { describe, expect, test, vi } from "vitest";

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

import { AnalyticsPlugin } from "../analytics";

/**
 * Tests the read-only SQL enforcement on the analytics agent tool.
 *
 * The tool is annotated `{ readOnly: true, requiresUserContext: true }`; this
 * suite verifies that the annotation is enforced at execution time — not just
 * exposed as metadata to the LLM — by the `assertReadOnlySql` guard in the
 * tool's handler.
 */

function makePlugin(): AnalyticsPlugin {
  return new AnalyticsPlugin({});
}

describe("AnalyticsPlugin.query agent tool — annotations", () => {
  test('is advertised with effect:"read" and requiresUserContext:true', () => {
    const plugin = makePlugin();
    const defs = plugin.getAgentTools();
    const query = defs.find((d) => d.name === "query");
    expect(query).toBeDefined();
    expect(query?.annotations).toEqual({
      effect: "read",
      requiresUserContext: true,
    });
  });
});

describe("AnalyticsPlugin.query agent tool — runtime enforcement", () => {
  test("rejects a DROP statement before it reaches this.query", async () => {
    const plugin = makePlugin();
    const spy = vi
      .spyOn(plugin, "query")
      .mockResolvedValue({ rows: [] } as any);
    await expect(
      plugin.executeAgentTool("query", { query: "DROP TABLE users" }),
    ).rejects.toThrow(/read-only policy violation/i);
    expect(spy).not.toHaveBeenCalled();
  });

  test("rejects UPDATE, DELETE, INSERT, TRUNCATE, GRANT", async () => {
    const plugin = makePlugin();
    const spy = vi
      .spyOn(plugin, "query")
      .mockResolvedValue({ rows: [] } as any);
    for (const q of [
      "UPDATE users SET email='x'",
      "DELETE FROM orders",
      "INSERT INTO x VALUES (1)",
      "TRUNCATE TABLE orders",
      "GRANT SELECT ON t TO u",
    ]) {
      await expect(
        plugin.executeAgentTool("query", { query: q }),
      ).rejects.toThrow(/read-only policy violation/i);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test("rejects a stacked SELECT + DROP", async () => {
    const plugin = makePlugin();
    const spy = vi
      .spyOn(plugin, "query")
      .mockResolvedValue({ rows: [] } as any);
    await expect(
      plugin.executeAgentTool("query", {
        query: "SELECT 1; DROP TABLE users",
      }),
    ).rejects.toThrow(/DROP/);
    expect(spy).not.toHaveBeenCalled();
  });

  test("passes a plain SELECT through to this.query", async () => {
    const plugin = makePlugin();
    const spy = vi
      .spyOn(plugin, "query")
      .mockResolvedValue({ rows: [{ id: 1 }] } as any);
    const result = await plugin.executeAgentTool("query", {
      query: "SELECT * FROM main.sales.orders",
    });
    expect(result).toEqual({ rows: [{ id: 1 }] });
    expect(spy).toHaveBeenCalledWith(
      "SELECT * FROM main.sales.orders",
      undefined,
      undefined,
      undefined,
    );
  });

  test("passes WITH … SELECT through", async () => {
    const plugin = makePlugin();
    const spy = vi
      .spyOn(plugin, "query")
      .mockResolvedValue({ rows: [] } as any);
    await plugin.executeAgentTool("query", {
      query: "WITH a AS (SELECT 1) SELECT * FROM a",
    });
    expect(spy).toHaveBeenCalledOnce();
  });

  test("passes SHOW TABLES through", async () => {
    const plugin = makePlugin();
    const spy = vi
      .spyOn(plugin, "query")
      .mockResolvedValue({ rows: [] } as any);
    await plugin.executeAgentTool("query", {
      query: "SHOW TABLES IN main.sales",
    });
    expect(spy).toHaveBeenCalledOnce();
  });
});
