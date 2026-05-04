import type { Pool } from "pg";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createLakebasePool } from "../../../connectors/lakebase";
import { defineSchema, id } from "../../../database";
import { loadSchemaByConvention } from "../convention";
import { database } from "../database";

vi.mock("../../../connectors/lakebase", () => ({
  createLakebasePool: vi.fn(),
}));

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getOrExecute: vi.fn(async (_key: unknown[], fn: () => Promise<unknown>) =>
        fn(),
      ),
      generateKey: vi.fn(),
    })),
  },
}));

vi.mock("../convention", () => ({
  loadSchemaByConvention: vi.fn(),
}));

const pool = {
  end: vi.fn(async () => undefined),
  on: vi.fn(),
} as unknown as Pool;

type DatabasePluginInstance = InstanceType<
  ReturnType<typeof database>["plugin"]
>;

function createPlugin(config: Parameters<typeof database>[0] = {}) {
  const pluginData = database(config);
  return new pluginData.plugin(pluginData.config) as DatabasePluginInstance;
}

describe("DatabasePlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createLakebasePool).mockReturnValue(pool);
    vi.mocked(loadSchemaByConvention).mockResolvedValue(null);
  });

  test("plugin factory exposes the database plugin name", () => {
    expect(database().name).toBe("database");
  });

  test("initializes the pool with defaults and config overrides", async () => {
    const plugin = createPlugin({
      connection: { max: 3 },
    });

    await plugin.setup();

    expect(createLakebasePool).toHaveBeenCalledWith({
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      maxUses: 1000,
    });
    expect(plugin.exports()).toEqual({ getPool: expect.any(Function) });
    expect((plugin.exports() as { getPool: () => Pool }).getPool()).toBe(pool);
  });

  test("stores convention-loaded schemas when present", async () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", { id: id() }),
    }));
    vi.mocked(loadSchemaByConvention).mockResolvedValue({
      schema,
      schemaPath: "/app/config/database/schema.ts",
    });

    const plugin = createPlugin();
    await plugin.setup();

    expect(
      (plugin as unknown as { schema: typeof schema; schemaPath: string })
        .schema,
    ).toBe(schema);
    expect(
      (plugin as unknown as { schema: typeof schema; schemaPath: string })
        .schemaPath,
    ).toBe("/app/config/database/schema.ts");
  });

  test("closes the pool during shutdown", async () => {
    const plugin = createPlugin();
    await plugin.setup();

    await plugin.abortActiveOperations();

    expect(pool.end).toHaveBeenCalled();
  });

  test("abortActiveOperations awaits pool.end so SIGTERM doesn't cut drain", async () => {
    let drainResolve: (() => void) | undefined;
    const drainGate = new Promise<void>((resolve) => {
      drainResolve = resolve;
    });
    const slowPool = {
      end: vi.fn(() => drainGate),
      on: vi.fn(),
    } as unknown as Pool;
    vi.mocked(createLakebasePool).mockReturnValueOnce(slowPool);

    const plugin = createPlugin();
    await plugin.setup();

    const promise = plugin.abortActiveOperations();
    let settled = false;
    promise?.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    drainResolve?.();
    await promise;
    expect(settled).toBe(true);
  });

  test("setup applies session defaults (application_name + statement_timeout) on every new connection", async () => {
    const plugin = createPlugin({ statementTimeoutMs: 7_000 });
    await plugin.setup();

    expect(pool.on).toHaveBeenCalledWith("connect", expect.any(Function));
    const handler = vi
      .mocked(pool.on)
      .mock.calls.find(
        ([event]) => event === "connect",
      )?.[1] as unknown as (client: {
      query: ReturnType<typeof vi.fn>;
    }) => void;
    const client = { query: vi.fn(async () => ({})) };
    handler(client);
    expect(client.query).toHaveBeenCalledWith(
      "SET application_name = 'appkit:database'",
    );
    expect(client.query).toHaveBeenCalledWith("SET statement_timeout = 7000");
  });

  test("schema-load failure is decorated and re-raised by default", async () => {
    vi.mocked(loadSchemaByConvention).mockRejectedValue(
      new Error("syntax error in schema.ts"),
    );

    const plugin = createPlugin();
    await expect(plugin.setup()).rejects.toThrow("syntax error in schema.ts");
  });

  test("schema-load failure is swallowed when tolerateSetupFailure is set", async () => {
    vi.mocked(loadSchemaByConvention).mockRejectedValue(
      new Error("syntax error in schema.ts"),
    );

    const plugin = createPlugin({ tolerateSetupFailure: true });
    await expect(plugin.setup()).resolves.toBeUndefined();
  });
});
