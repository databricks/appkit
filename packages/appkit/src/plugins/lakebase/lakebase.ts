import { WorkspaceClient } from "@databricks/sdk-experimental";
import type express from "express";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import {
  createLakebasePool,
  createLakebasePoolManager,
  getLakebaseOrmConfig,
  getLakebasePgConfig,
  getUsernameWithApiLookup,
  type LakebasePoolManager,
} from "../../connectors/lakebase";
import { AuthenticationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import manifest from "./manifest.json";
import type { ILakebaseConfig } from "./types";

const logger = createLogger("lakebase");

/** Default pool settings for per-user OBO pools. */
const OBO_POOL_DEFAULTS = {
  max: 3,
  allowExitOnIdle: true,
  idleTimeoutMillis: 30_000,
};

/**
 * AppKit plugin for Databricks Lakebase Autoscaling.
 *
 * Wraps `@databricks/lakebase` to provide a standard `pg.Pool` with automatic
 * OAuth token refresh, integrated with AppKit's logger and OpenTelemetry setup.
 *
 * Supports On-Behalf-Of (OBO) via `asUser(req)` — each user gets a separate
 * `pg.Pool` authenticated with their Databricks identity, enabling features
 * like Row-Level Security (RLS).
 *
 * @example
 * ```ts
 * import { createApp, lakebase, server } from "@databricks/appkit";
 *
 * const AppKit = await createApp({
 *   plugins: [server(), lakebase()],
 * });
 *
 * // Service principal query
 * const result = await AppKit.lakebase.query("SELECT * FROM users WHERE id = $1", [userId]);
 *
 * // User-scoped query (per-user pool, RLS enforced)
 * const mine = await AppKit.lakebase.asUser(req).query("SELECT * FROM my_data");
 * ```
 */
class LakebasePlugin extends Plugin {
  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"lakebase">;

  protected declare config: ILakebaseConfig;
  private pool: Pool | null = null;
  private oboPoolManager: LakebasePoolManager | null = null;

  constructor(config: ILakebaseConfig) {
    super(config);
    this.config = config;
  }

  /**
   * Initializes the Lakebase connection pool and OBO pool manager.
   * Called automatically by AppKit during the plugin setup phase.
   *
   * Resolves the PostgreSQL username via {@link getUsernameWithApiLookup},
   * which tries config, env vars, and finally the Databricks workspace API.
   */
  async setup() {
    const poolConfig = this.config.pool;
    const user = await getUsernameWithApiLookup(poolConfig);
    this.pool = createLakebasePool({ ...poolConfig, user });
    logger.info("Lakebase pool initialized");

    this.oboPoolManager = createLakebasePoolManager({
      ...poolConfig,
      ...OBO_POOL_DEFAULTS,
    });
    logger.info("Lakebase OBO pool manager initialized");
  }

  /**
   * Executes a parameterized SQL query against the Lakebase pool.
   *
   * @param text - SQL query string, using `$1`, `$2`, ... placeholders
   * @param values - Parameter values corresponding to placeholders
   * @returns Query result with typed rows
   *
   * @example
   * ```ts
   * const result = await AppKit.lakebase.query<{ id: number; name: string }>(
   *   "SELECT id, name FROM users WHERE active = $1",
   *   [true],
   * );
   * ```
   */
  async query<T extends QueryResultRow = any>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    // biome-ignore lint/style/noNonNullAssertion: pool is guaranteed non-null after setup(), which AppKit always awaits before exposing the plugin API
    return this.pool!.query<T>(text, values);
  }

  /**
   * Returns a user-scoped version of the plugin that uses a per-user
   * connection pool authenticated with the user's Databricks identity.
   *
   * Overrides the base `Plugin.asUser()` because Lakebase needs entirely
   * separate `pg.Pool` instances per user (each with their own OAuth token
   * refresh), rather than the standard AsyncLocalStorage context swap.
   *
   * @param req - Express request containing `x-forwarded-access-token` and `x-forwarded-user` headers
   * @returns A proxied plugin instance where `query()` and `pool` use the user's pool
   */
  asUser(req: express.Request): this {
    const token = req.header("x-forwarded-access-token");
    const userId = req.header("x-forwarded-user");
    const isDev = process.env.NODE_ENV === "development";

    // In dev mode without token, delegate to the base class dev fallback
    // which uses the SP pool with DEV_OBO_FALLBACK_KEY in OTel context
    if (!token && isDev) {
      return super.asUser(req);
    }

    if (!token) {
      throw AuthenticationError.missingToken("user token");
    }

    if (!userId && !isDev) {
      throw AuthenticationError.missingUserId();
    }

    const effectiveUserId = userId || "dev-user";

    // Get or create a per-user pool
    // biome-ignore lint/style/noNonNullAssertion: oboPoolManager is guaranteed non-null after setup()
    const isNew = !this.oboPoolManager!.hasPool(effectiveUserId);
    // biome-ignore lint/style/noNonNullAssertion: oboPoolManager is guaranteed non-null after setup()
    const userPool = this.oboPoolManager!.getPool(effectiveUserId, {
      workspaceClient: new WorkspaceClient({
        token,
        host: process.env.DATABRICKS_HOST,
        authType: "pat",
      }),
      user: effectiveUserId,
    });

    if (isNew) {
      logger.info(
        'Created OBO pool for user "%s" (total: %d)',
        effectiveUserId,
        // biome-ignore lint/style/noNonNullAssertion: oboPoolManager is guaranteed non-null after setup()
        this.oboPoolManager!.size,
      );
    }

    const pluginConfig = this.config;

    // Return a proxy that intercepts pool-related methods and exports
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return <T extends QueryResultRow = any>(
            text: string,
            values?: unknown[],
          ): Promise<QueryResult<T>> => userPool.query<T>(text, values);
        }

        if (prop === "exports") {
          return () => ({
            pool: userPool,
            query: <T extends QueryResultRow = any>(
              text: string,
              values?: unknown[],
            ) => userPool.query<T>(text, values),
            getOrmConfig: () =>
              getLakebaseOrmConfig({
                ...pluginConfig.pool,
                workspaceClient: new WorkspaceClient({
                  token,
                  host: process.env.DATABRICKS_HOST,
                  authType: "pat",
                }),
                user: effectiveUserId,
              }),
            getPgConfig: () =>
              getLakebasePgConfig({
                ...pluginConfig.pool,
                workspaceClient: new WorkspaceClient({
                  token,
                  host: process.env.DATABRICKS_HOST,
                  authType: "pat",
                }),
                user: effectiveUserId,
              }),
          });
        }

        if (prop === "asUser") {
          return () => {
            throw new Error("asUser() cannot be chained");
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    }) as this;
  }

  /**
   * Gracefully drains and closes all connection pools (SP + OBO).
   * Called automatically by AppKit during shutdown.
   */
  abortActiveOperations(): void {
    super.abortActiveOperations();
    if (this.pool) {
      logger.info("Closing Lakebase SP pool");
      this.pool.end().catch((err) => {
        logger.error("Error closing Lakebase SP pool: %O", err);
      });
      this.pool = null;
    }
    if (this.oboPoolManager) {
      logger.info(
        "Closing all Lakebase OBO pools (%d)",
        this.oboPoolManager.size,
      );
      this.oboPoolManager.closeAll().catch((err) => {
        logger.error("Error closing Lakebase OBO pools: %O", err);
      });
      this.oboPoolManager = null;
    }
  }

  /**
   * Returns the plugin's public API, accessible via `AppKit.lakebase`.
   *
   * - `pool` — The raw `pg.Pool` instance (service principal), for use with ORMs or advanced scenarios
   * - `query` — Convenience method for executing parameterized SQL queries
   * - `getOrmConfig()` — Returns a config object compatible with Drizzle, TypeORM, Sequelize, etc.
   * - `getPgConfig()` — Returns a `pg.PoolConfig` object for manual pool construction
   *
   * Use `AppKit.lakebase.asUser(req)` to get the same API backed by a per-user pool.
   */
  exports() {
    return {
      // biome-ignore lint/style/noNonNullAssertion: pool is guaranteed non-null after setup(), which AppKit always awaits before exposing the plugin API
      pool: this.pool!,
      query: this.query.bind(this),
      getOrmConfig: () => getLakebaseOrmConfig(this.config.pool),
      getPgConfig: () => getLakebasePgConfig(this.config.pool),
    };
  }
}

/**
 * @internal
 */
export const lakebase = toPlugin(LakebasePlugin);
