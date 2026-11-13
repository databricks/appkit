import { EventEmitter } from "node:events";

import pg from "pg";
import { type Options, type PoolOptions, Sequelize } from "sequelize";
import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getLakebaseOrmConfig } from "../pool-config";
import type { LakebasePoolConfig, Logger } from "../types";

// These tests run the real ORMs against a fake `pg` module, so they show what
// TypeORM and Sequelize actually pass to pg, without a database.

// config.ts falls back to these, so clear them to keep a developer's shell
// from changing the result.
const ENV_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGSSLMODE",
  "LAKEBASE_ENDPOINT",
  "DATABRICKS_CLIENT_ID",
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function ormConfig(config: Partial<LakebasePoolConfig> = {}) {
  return getLakebaseOrmConfig({
    host: "ep-test.database.us-east-1.databricks.com",
    database: "databricks_postgres",
    user: "test-user@example.com",
    password: "test-only",
    ...config,
  });
}

describe("TypeORM", () => {
  // The options TypeORM passes to pg.Pool, given a Lakebase config and any
  // TypeORM options the caller sets after the spread.
  async function poolOptionsFor(
    config: Partial<LakebasePoolConfig>,
    typeormOptions: Record<string, unknown> = {},
  ): Promise<pg.PoolConfig> {
    let captured: pg.PoolConfig | undefined;

    // Real pg.Pool, so `options` is what pg-pool resolved, but it stops before
    // a real connection opens. TypeORM calls `new Pool(...)`; a constructor
    // that returns an object gives back that object.
    function CapturingPool(options: pg.PoolConfig): pg.Pool {
      const pool = new pg.Pool(options);
      captured = pool.options;
      return Object.assign(pool, {
        connect: (callback: (err: Error) => void) =>
          callback(new Error("test: no database")),
      });
    }

    const dataSource = new DataSource({
      type: "postgres",
      ...ormConfig(config),
      ...typeormOptions,
      driver: { ...pg, Pool: CapturingPool as unknown as typeof pg.Pool },
    });
    await expect(dataSource.initialize()).rejects.toThrow("test: no database");

    if (!captured) {
      throw new Error("TypeORM didn't create a pg.Pool");
    }
    return captured;
  }

  test("passes the connection lifetime to pg.Pool", async () => {
    const options = await poolOptionsFor({});
    expect(options.maxLifetimeSeconds).toBe(30 * 60);
  });

  test("passes an explicit lifetime, pool size and timeouts to pg.Pool", async () => {
    const options = await poolOptionsFor({
      maxLifetimeSeconds: 600,
      max: 7,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 3_000,
    });

    expect(options).toMatchObject({
      maxLifetimeSeconds: 600,
      max: 7,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 3_000,
    });
  });

  // TypeORM merges `extra` over its own options, so these must not go in
  // `extra`, or they'd override what the caller sets.
  test("lets the caller's poolSize, connectTimeoutMS and applicationName win", async () => {
    const options = await poolOptionsFor(
      { max: 7, connectionTimeoutMillis: 2_000, application_name: "lakebase" },
      { poolSize: 20, connectTimeoutMS: 4_000, applicationName: "mine" },
    );

    expect(options).toMatchObject({
      max: 20,
      connectionTimeoutMillis: 4_000,
      application_name: "mine",
    });
  });

  test("passes the Lakebase pool size, connect timeout and application name when the caller doesn't set them", async () => {
    const options = await poolOptionsFor({
      max: 7,
      connectionTimeoutMillis: 2_000,
      application_name: "lakebase",
    });

    expect(options).toMatchObject({
      max: 7,
      connectionTimeoutMillis: 2_000,
      application_name: "lakebase",
    });
  });

  test("keeps the caller's own extra settings when they merge as documented", async () => {
    const config = ormConfig({ maxLifetimeSeconds: 600 });
    const options = await poolOptionsFor(
      { maxLifetimeSeconds: 600 },
      { extra: { ...config.extra, allowExitOnIdle: true } },
    );

    expect(options).toMatchObject({
      maxLifetimeSeconds: 600,
      allowExitOnIdle: true,
    });
  });
});

describe("Sequelize", () => {
  // A pg.Client stand-in: connects at once and answers every query with no
  // rows.
  class FakeClient extends EventEmitter {
    static instances: FakeClient[] = [];

    readonly connection = new EventEmitter();
    // Saves Sequelize a "SET standard_conforming_strings" round trip.
    readonly standard_conforming_strings = "on";
    ended = false;

    constructor(readonly config: pg.ClientConfig) {
      super();
      FakeClient.instances.push(this);
    }

    connect(callback: (err: Error | null) => void): void {
      setImmediate(() => callback(null));
    }

    async query(): Promise<{ rows: never[]; rowCount: number }> {
      return { rows: [], rowCount: 0 };
    }

    end(callback?: () => void): void {
      this.ended = true;
      this.emit("end");
      callback?.();
    }
  }

  beforeEach(() => {
    FakeClient.instances = [];
  });

  function makeSequelize(
    config: Partial<LakebasePoolConfig> = {},
    sequelizeOptions: Record<string, unknown> = {},
  ) {
    // Cast: Sequelize's types don't list `databaseVersion`, or a function for
    // `password` (both work at runtime).
    return new Sequelize({
      dialect: "postgres",
      dialectModule: { types: pg.types, Client: FakeClient },
      // Skips the server-version query.
      databaseVersion: "16.0.0",
      logging: false,
      ...ormConfig(config),
      ...sequelizeOptions,
    } as Options);
  }

  test("uses the pool size from the Lakebase config", () => {
    const sequelize = makeSequelize({ max: 7 });
    // `pool` is sequelize-pool's Pool; Sequelize's types leave it out.
    const { pool } = sequelize.connectionManager as unknown as {
      pool: { maxSize: number };
    };
    expect(pool.maxSize).toBe(7);
  });

  test("replaces an idle connection once it's older than the lifetime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sequelize = makeSequelize({ maxLifetimeSeconds: 600 });
    const { connectionManager } = sequelize;

    const first = await connectionManager.getConnection({ type: "write" });
    connectionManager.releaseConnection(first);

    vi.advanceTimersByTime(599_000);
    const reused = await connectionManager.getConnection({ type: "write" });
    expect(reused).toBe(first);
    connectionManager.releaseConnection(reused);

    vi.advanceTimersByTime(2_000);
    const replacement = await connectionManager.getConnection({
      type: "write",
    });
    expect(replacement).not.toBe(first);
    expect((first as unknown as FakeClient).ended).toBe(true);

    connectionManager.releaseConnection(replacement);
    await sequelize.close();
  });

  test("never replaces a connection for age when the lifetime is 0", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sequelize = makeSequelize({ maxLifetimeSeconds: 0 });
    const { connectionManager } = sequelize;

    const first = await connectionManager.getConnection({ type: "write" });
    connectionManager.releaseConnection(first);

    vi.advanceTimersByTime(24 * 60 * 60_000);
    const reused = await connectionManager.getConnection({ type: "write" });
    expect(reused).toBe(first);

    connectionManager.releaseConnection(reused);
    await sequelize.close();
  });

  test("still drops a connection Sequelize marked invalid", async () => {
    const sequelize = makeSequelize();
    const { connectionManager } = sequelize;

    const first = await connectionManager.getConnection({ type: "write" });
    (first as unknown as { _invalid: boolean })._invalid = true;
    connectionManager.releaseConnection(first);

    const next = await connectionManager.getConnection({ type: "write" });
    expect(next).not.toBe(first);

    connectionManager.releaseConnection(next);
    await sequelize.close();
  });
  async function clientConfigFor(config: Partial<LakebasePoolConfig>) {
    const sequelize = makeSequelize(config);
    const connection = await sequelize.connectionManager.getConnection({
      type: "write",
    });
    sequelize.connectionManager.releaseConnection(connection);
    await sequelize.close();
    return FakeClient.instances[0].config;
  }

  // Before, Sequelize never received `ssl` or the client timeouts: pg fell
  // back to PGSSLMODE and its own defaults. Each sslMode now reaches
  // pg.Client the same way it reaches pg.Pool, along with the timeouts.
  test.each([
    ["require", { rejectUnauthorized: true }],
    ["prefer", { rejectUnauthorized: false }],
    ["disable", false],
  ] as const)(
    "passes sslMode %s and the client timeouts to pg.Client",
    async (sslMode, expected) => {
      const config = await clientConfigFor({
        sslMode,
        statement_timeout: 3_000,
        connectionTimeoutMillis: 2_000,
      });
      expect(config.ssl).toEqual(expected);
      expect(config).toMatchObject({
        statement_timeout: 3_000,
        connectionTimeoutMillis: 2_000,
      });
    },
  );

  test("keeps recycling, from first reuse, and warns once when the caller replaces hooks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const sequelize = makeSequelize(
      { maxLifetimeSeconds: 600, logger },
      { hooks: { beforeConnect: () => {} } },
    );
    const { connectionManager } = sequelize;

    const first = await connectionManager.getConnection({ type: "write" });
    connectionManager.releaseConnection(first);

    // First reuse: no open time was recorded, so the clock starts here.
    const reused = await connectionManager.getConnection({ type: "write" });
    expect(reused).toBe(first);
    connectionManager.releaseConnection(reused);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(601_000);
    const replacement = await connectionManager.getConnection({
      type: "write",
    });
    expect(replacement).not.toBe(first);
    // The replacement isn't stamped either, but the warning isn't repeated.
    connectionManager.releaseConnection(replacement);
    const again = await connectionManager.getConnection({ type: "write" });
    expect(again).toBe(replacement);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    connectionManager.releaseConnection(again);
    await sequelize.close();
  });

  // Compile-time check: the documented merge pattern typechecks against
  // Sequelize's own option types (typecheck covers this file).
  test("the documented merge pattern fits Sequelize's types", () => {
    const config = ormConfig();
    const pool: PoolOptions = { ...config.pool, min: 2 };
    const hooks: Options["hooks"] = {
      ...config.hooks,
      beforeConnect: async () => {},
    };

    expect(pool.validate).toBe(config.pool.validate);
    expect(hooks?.afterConnect).toBe(config.hooks.afterConnect);
  });
});

describe("logging", () => {
  // Fails every token fetch: any use of the client throws.
  const failingClient = new Proxy(
    {},
    {
      get() {
        throw new Error("test: token fetch failed");
      },
    },
  ) as LakebasePoolConfig["workspaceClient"];

  // An invalid lifetime (which warns) and an OAuth password callback whose
  // token fetch fails (which logs an error).
  function noisyConfig(logger?: Logger) {
    return ormConfig({
      password: undefined,
      endpoint: "projects/p/branches/b/endpoints/e",
      workspaceClient: failingClient,
      maxLifetimeSeconds: -5,
      logger,
    });
  }

  test("doesn't log anything when no logger is configured", async () => {
    const consoleSpies = (
      ["error", "warn", "info", "log", "debug"] as const
    ).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));

    const config = noisyConfig();
    await expect((config.password as () => Promise<string>)()).rejects.toThrow(
      "test: token fetch failed",
    );

    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  test("logs warnings and token-fetch errors to a configured logger", async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const config = noisyConfig(logger);
    await expect((config.password as () => Promise<string>)()).rejects.toThrow(
      "test: token fetch failed",
    );

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
