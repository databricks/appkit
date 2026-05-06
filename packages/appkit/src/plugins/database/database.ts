import type { Pool } from "pg";
import type { IAppRouter } from "shared";
import { Plugin, toPlugin } from "@/plugin";
import { createLakebasePool } from "../../connectors/lakebase";
import type { DataPath, Schema } from "../../database";
import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { PluginManifest } from "../../registry";
import { loadSchemaByConvention } from "./convention";
import {
  APPLICATION_NAME,
  POOL_DEFAULTS,
  STATEMENT_TIMEOUT_DEFAULT_MS,
} from "./defaults";
import { checkDrift } from "./drift";
import type { EntityClient, ExecutorFn } from "./entity-proxy";
import { type UserPoolRegistry, wireEntities } from "./entity-wiring";
import manifest from "./manifest.json";
import { RouteGenerator } from "./route-generator";
import type { HttpAccess, IDatabaseConfig } from "./types";

const logger = createLogger("database");

type TransactionFn<T> = (tx: DataPath) => Promise<T>;

type DatabaseExports = {
  [entity: string]:
    | EntityClient
    | (() => Pool)
    | (<T>(fn: TransactionFn<T>) => Promise<T>)
    | ((
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown[]>);
  getPool: () => Pool;
  transaction: <T>(fn: TransactionFn<T>) => Promise<T>;
  sql: (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown[]>;
};

class DatabasePlugin extends Plugin<IDatabaseConfig> {
  static manifest = manifest as PluginManifest<"database">;

  protected declare config: IDatabaseConfig;
  protected pool: Pool | null = null;
  protected schema: Schema | null = null;
  protected schemaPath: string | null = null;
  protected entities: Record<string, EntityClient> = {};
  protected dataPath: DataPath | null = null;
  protected userPools: UserPoolRegistry | null = null;

  constructor(config: IDatabaseConfig = {}) {
    super(config);
    this.config = config;
  }

  async setup() {
    // SP pool via the standalone `lakebase` factory — OAuth refresh built in,
    // user OAuth in dev, SP OAuth in prod.
    this.pool = createLakebasePool({
      ...POOL_DEFAULTS,
      ...this.config.connection,
    });
    attachSessionDefaults(this.pool, this.config.statementTimeoutMs);
    if (process.env.DEBUG_POOL)
      startPoolStatsLog(this.pool, "service-principal");
    logger.info("Database plugin pool initialized");

    try {
      const loaded = await loadSchemaByConvention();
      if (!loaded) {
        logger.warn(
          "Database plugin did not find config/database/schema.ts; running with no entities",
        );
        return;
      }

      this.schema = loaded.schema;
      this.schemaPath = loaded.schemaPath;
      logger.info(
        "Database schema loaded from %s with %d entries",
        loaded.schemaPath,
        Object.keys(loaded.schema.$tables).length,
      );

      // Wiring → one EntityClient per table on the SP pool + per-user pool
      // registry for `EntityClient.asUser(req)` (OBO).
      const executor: ExecutorFn = async (fn, options) => {
        const result = await this.execute(fn, options);
        if (!result.ok) {
          // Preserve the interceptor's status (already scrubbed for prod by
          // Plugin#execute) so the route can echo the right HTTP code.
          throw new DatabaseRouteError(result.status, result.message);
        }
        return result.data;
      };

      const wired = wireEntities({
        schema: this.schema,
        config: this.config,
        servicePool: this.pool,
        executor,
      });

      this.entities = wired.entities;
      this.dataPath = wired.dataPath;
      this.userPools = wired.userPools;
      logger.info(
        "Database entity API wired for: %s",
        Object.keys(this.entities).join(", "),
      );

      // Cap drift introspection so a wedged pool can't hang boot indefinitely.
      await withTimeout(
        checkDrift({
          pool: this.requirePool(),
          schema: this.schema,
          enabled: this.config.checkDrift !== false,
          tolerateIntrospectionFailure: this.config.tolerateSetupFailure,
        }),
        10_000,
        "Database drift check exceeded 10s timeout during setup",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Database setup failed: %s", message);
      if (!this.config.tolerateSetupFailure) throw err;
    }
  }

  injectRoutes(router: IAppRouter): void {
    if (!this.schema) return;

    new RouteGenerator({
      schema: this.schema,
      config: this.config,
      getSurface: (req, access) => this.getSurface(req, access),
      getServicePool: () => this.requirePool(),
      route: (target, config) => this.route(target, config),
    }).injectAll(router);
  }

  asUser(req: import("express").Request): this {
    const baseProxy = super.asUser(req);

    // No registry means setup() ran without a schema. Nothing to scope.
    if (!this.userPools) return baseProxy;

    const identity = this.userPools.resolveIdentity(req);
    // Dev fallback: identity is null when OBO headers are absent in dev.
    // resolveIdentity already logged the warning; throws in prod.
    if (!identity) return baseProxy;

    const userPool = this.userPools.getOrCreate(identity);
    const userDataPath = this.userPools.getOrCreateDataPath(identity);

    const userEntities: Record<string, EntityClient> = {};
    for (const [name, client] of Object.entries(this.entities)) {
      userEntities[name] = client.asUser(req);
    }

    const userExports = (): DatabaseExports => ({
      ...userEntities,
      getPool: () => userPool,
      transaction: <T>(fn: TransactionFn<T>) => userDataPath.transaction(fn),
      sql: (strings, ...values) => userDataPath.raw(strings, ...values),
    });

    return new Proxy(baseProxy, {
      get: (target, prop, receiver) => {
        if (prop === "exports") return userExports;
        if (typeof prop === "string" && prop in userEntities) {
          return userEntities[prop];
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as this;
  }

  async abortActiveOperations(): Promise<void> {
    super.abortActiveOperations();

    // Drain the SP pool first, then any per-user pools built by asUser().
    const drains: Array<Promise<void>> = [];
    if (this.pool) {
      logger.info("Closing database pool");
      const draining = this.pool.end().catch((err) => {
        logger.error("Error closing database pool: %O", err);
      });
      this.pool = null;
      drains.push(draining);
    }

    if (this.userPools) {
      const pools = this.userPools;
      this.userPools = null;
      drains.push(
        pools.closeAll().catch((err) => {
          logger.error("Error closing per-user database pools: %O", err);
        }),
      );
    }

    await Promise.all(drains);
  }

  exports(): DatabaseExports {
    return {
      ...this.entities,
      getPool: () => this.requirePool(),
      transaction: <T>(fn: TransactionFn<T>) =>
        this.requireDataPath().transaction(fn),
      sql: (strings, ...values) =>
        this.requireDataPath().raw(strings, ...values),
    };
  }

  protected requireDataPath(): DataPath {
    if (!this.dataPath) {
      throw ConfigurationError.resourceNotFound(
        "Database",
        "Database runtime not initialized — declare config/database/schema.ts before calling transaction() or sql``.",
      );
    }
    return this.dataPath;
  }

  protected requirePool(): Pool {
    if (!this.pool) {
      throw ConfigurationError.resourceNotFound(
        "Database",
        "Database pool not initialized",
      );
    }
    return this.pool;
  }

  private getSurface(
    req: import("express").Request,
    access: HttpAccess,
  ): Record<string, EntityClient> {
    if (access === "obo") {
      return this.asUser(req).exports() as Record<string, EntityClient>;
    }
    return this.exports() as Record<string, EntityClient>;
  }
}

export const database = toPlugin(DatabasePlugin);

/**
 * Carries the interceptor-derived HTTP status to the route handler so 4xx
 * classifications survive the throw. Other errors fall back to scrubbed 500.
 */
export class DatabaseRouteError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DatabaseRouteError";
    this.statusCode = statusCode;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Set per-session defaults on every new pooled connection: `statement_timeout`
 * caps runaway queries; `application_name` attributes traffic in `pg_stat_activity`.
 */
function attachSessionDefaults(pool: Pool, override?: number): void {
  const ms = override ?? STATEMENT_TIMEOUT_DEFAULT_MS;
  pool.on("connect", (client) => {
    client
      .query(`SET application_name = '${APPLICATION_NAME}'`)
      .catch((err) => {
        logger.error(
          "Failed to set application_name on pool connection: %O",
          err,
        );
      });
    if (Number.isFinite(ms) && ms > 0) {
      client.query(`SET statement_timeout = ${Math.floor(ms)}`).catch((err) => {
        logger.error(
          "Failed to set statement_timeout on pool connection: %O",
          err,
        );
      });
    }
  });
}

/**
 * Log pool total/idle/waiting every 30s when `DEBUG_POOL=1` is set. Unrefed
 * so it never blocks shutdown.
 */
function startPoolStatsLog(pool: Pool, label: string): void {
  const intervalMs = 30_000;
  const handle = setInterval(() => {
    logger.info(
      "Pool stats [%s] total=%d idle=%d waiting=%d",
      label,
      pool.totalCount,
      pool.idleCount,
      pool.waitingCount,
    );
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
}
