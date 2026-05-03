import type { Pool } from "pg";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createLakebasePool } from "../../../connectors/lakebase";
import { defineSchema, id, text } from "../../../database";
import { loadSchemaByConvention } from "../convention";
import { database } from "../database";

vi.mock("../../../connectors/lakebase", () => ({
  createLakebasePool: vi.fn(),
  createLakebasePostgrestClient: vi.fn(),
}));

vi.mock("../../../database", async () => {
  const actual =
    await vi.importActual<typeof import("../../../database")>(
      "../../../database",
    );
  return {
    ...actual,
    // The runtime is exercised by entity-proxy tests with a fake DataPath;
    // here we only care that the plugin wires *something* per entity, so we
    // stub the runtime to avoid initialising drizzle + node-postgres.
    createDrizzleDataPath: vi.fn(() => ({
      select: vi.fn(async () => []),
      findOne: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      insert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({}),
      ),
      raw: vi.fn(async () => []),
    })),
  };
});

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
      // POOL_DEFAULTS.connectionTimeoutMillis was lowered to fail-fast on
      // pool acquire so the timeout interceptor + retry can re-route under
      // saturation (was 10_000).
      connectionTimeoutMillis: 3_000,
      maxUses: 1000,
    });
    expect(plugin.exports()).toMatchObject({
      getPool: expect.any(Function),
      transaction: expect.any(Function),
      sql: expect.any(Function),
    });
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

  test("wires one entity client per schema table on the SP pool", async () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
      }),
    }));
    vi.mocked(loadSchemaByConvention).mockResolvedValue({
      schema,
      schemaPath: "/app/config/database/schema.ts",
    });

    const plugin = createPlugin();
    await plugin.setup();

    const exports = plugin.exports() as unknown as {
      getPool: () => Pool;
      user: unknown;
    };
    expect(exports.getPool()).toBe(pool);
    expect(exports.user).toBeDefined();
    // The wiring goes through the SP pool; no Data API URL is required.
    expect(createLakebasePool).toHaveBeenCalled();
  });

  test("exports transaction(fn) and sql`` backed by the runtime data path", async () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", { id: id(), email: text().notNull() }),
    }));
    vi.mocked(loadSchemaByConvention).mockResolvedValue({
      schema,
      schemaPath: "/app/config/database/schema.ts",
    });

    const plugin = createPlugin();
    await plugin.setup();

    const exports = plugin.exports() as unknown as {
      transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
      sql: (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown[]>;
    };
    expect(typeof exports.transaction).toBe("function");
    expect(typeof exports.sql).toBe("function");

    // Round-trip through the stub DataPath wired in createDrizzleDataPath mock
    // (top of this file). Both should resolve via the stubbed methods.
    await expect(exports.transaction(async () => 42)).resolves.toBe(42);
    await expect(exports.sql`select 1`).resolves.toEqual([]);
  });

  test("injectRoutes registers entity routes once schema is loaded", async () => {
    const schema = defineSchema(({ table }) => ({
      user: table("user", {
        id: id(),
        email: text().notNull(),
      }),
    }));
    vi.mocked(loadSchemaByConvention).mockResolvedValue({
      schema,
      schemaPath: "/app/config/database/schema.ts",
    });

    const plugin = createPlugin();
    await plugin.setup();

    const router = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    plugin.injectRoutes(router as never);

    expect(router.get).toHaveBeenCalledWith("/user", expect.any(Function));
    expect(router.get).toHaveBeenCalledWith(
      "/user/count",
      expect.any(Function),
    );
    expect(router.get).toHaveBeenCalledWith("/user/:id", expect.any(Function));
    expect(router.post).toHaveBeenCalledWith("/user", expect.any(Function));
    expect(router.patch).toHaveBeenCalledWith(
      "/user/:id",
      expect.any(Function),
    );
    expect(router.delete).toHaveBeenCalledWith(
      "/user/:id",
      expect.any(Function),
    );
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
