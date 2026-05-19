import type { QueryResult, QueryResultRow } from "pg";
import type { AgentToolDefinition, ToolProvider } from "shared";
import { z } from "zod";
import {
  createLakebasePool,
  createLakebasePoolManager,
  getLakebaseOrmConfig,
  getLakebasePgConfig,
  getUsernameWithApiLookup,
  type LakebasePool,
  type LakebasePoolManager,
  RoutingPool,
} from "../../connectors/lakebase";
import { getUserContext } from "../../context/execution-context";
import { buildToolkitEntries } from "../../core/agent/build-toolkit";
import {
  defineTool,
  executeFromRegistry,
  toolsFromRegistry,
} from "../../core/agent/tools/define-tool";
import { assertReadOnlySql } from "../../core/agent/tools/sql-policy";
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
 * like Row-Level Security (RLS). Routing is handled transparently by
 * {@link RoutingPool}, which reads the execution context set by the base
 * class `asUser()`.
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
export class LakebasePlugin extends Plugin implements ToolProvider {
  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"lakebase">;

  protected declare config: ILakebaseConfig;
  private pool: RoutingPool | null = null;
  private oboPoolManager: LakebasePoolManager | null = null;

  /**
   * Initializes the Lakebase connection pool and OBO pool manager.
   * Called automatically by AppKit during the plugin setup phase.
   *
   * Creates a {@link RoutingPool} that automatically routes queries to either
   * the service-principal pool or a per-user pool based on the execution
   * context (set by `Plugin.asUser(req)` via AsyncLocalStorage).
   */
  async setup() {
    const poolConfig = this.config.pool;
    const user = await getUsernameWithApiLookup(poolConfig);

    const spPool = createLakebasePool({ ...poolConfig, user });
    logger.info("Lakebase SP pool initialized");

    this.oboPoolManager = createLakebasePoolManager({
      ...poolConfig,
      ...OBO_POOL_DEFAULTS,
    });
    logger.info("Lakebase OBO pool manager initialized");

    const oboManager = this.oboPoolManager;
    this.pool = new RoutingPool(spPool, (ctx) => {
      if (!oboManager) throw new Error("OBO pool manager not initialized");
      // Lakebase OAuth roles use email as the postgres role when available
      const userKey = ctx.userEmail ?? ctx.userId;
      const isNew = !oboManager.hasPool(userKey);
      const pool = oboManager.getPool(
        userKey,
        { workspaceClient: ctx.client, user: userKey },
        ctx.tokenFingerprint,
      );
      if (isNew) {
        logger.debug("Created OBO pool for user (total: %d)", oboManager.size);
      }
      return pool;
    });
  }

  /**
   * Executes a parameterized SQL query against the Lakebase pool.
   *
   * When called inside `asUser(req)`, the query automatically routes to
   * the per-user pool via {@link RoutingPool}.
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
   * Execute a single statement inside a `BEGIN READ ONLY … ROLLBACK`
   * transaction on a dedicated client.
   *
   * The three commands MUST share a connection — a naive
   * `pool.query("BEGIN READ ONLY; <stmt>; ROLLBACK")` batch cannot accept
   * parameter values (PostgreSQL's Extended Query protocol rejects multi-
   * statement prepared queries), which would silently break every
   * parameterized query the agent tool issues.
   *
   * Returns the raw `rows` array for the user's statement. Side effects the
   * statement may attempt (writes, writable-function side effects) are
   * rejected by PostgreSQL under the read-only transaction posture.
   */
  private async runReadOnlyStatement(
    text: string,
    values?: unknown[],
  ): Promise<unknown[]> {
    // biome-ignore lint/style/noNonNullAssertion: pool is guaranteed non-null after setup()
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const result = await client.query(text, values);
      return result.rows;
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
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
   * Agent tool registry. Empty by default — the Lakebase plugin does NOT
   * expose its SQL connection to LLM agents unless the developer explicitly
   * opts in via `config.exposeAsAgentTool`. See {@link buildQueryTool}.
   */
  private tools: Record<string, ReturnType<typeof this.buildQueryTool>> = {};

  constructor(config: ILakebaseConfig) {
    super(config);
    this.config = config;
    if (config.exposeAsAgentTool) {
      this.tools = { query: this.buildQueryTool(config.exposeAsAgentTool) };
      logger.warn(
        "Lakebase agent tool is enabled (readOnly=%s). Every agent with access to this plugin can execute SQL against the Lakebase database as the requesting user's identity.",
        config.exposeAsAgentTool.readOnly !== false,
      );
    }
  }

  private buildQueryTool(
    opt: NonNullable<ILakebaseConfig["exposeAsAgentTool"]>,
  ) {
    const readOnly = opt.readOnly !== false;
    return defineTool({
      description: readOnly
        ? "Execute a read-only SQL query against the Lakebase PostgreSQL database. Only SELECT, WITH, SHOW, EXPLAIN, and DESCRIBE statements are accepted. Use $1, $2, etc. as placeholders and pass values separately."
        : "Execute a parameterized SQL statement against the Lakebase PostgreSQL database. Use $1, $2, etc. as placeholders and pass values separately. This tool can modify data; every invocation requires explicit human approval.",
      schema: z.object({
        text: z
          .string()
          .describe(
            "SQL statement with $1, $2, ... placeholders for parameters",
          ),
        values: z
          .array(z.unknown())
          .optional()
          .describe("Parameter values corresponding to placeholders"),
      }),
      annotations: {
        effect: readOnly ? "read" : "destructive",
        idempotent: false,
        requiresUserContext: true,
      },
      execute: async (args, signal) => {
        // Matches the files plugin pattern: the pg connection API
        // doesn't accept AbortSignal in its current shape, so deeper
        // mid-call cancellation needs a separate plumbing pass on the
        // connector. This entry check still catches the common case —
        // a tool dispatched after the user already cancelled the
        // stream — and unwinds cleanly instead of running to
        // completion against the SQL warehouse.
        signal?.throwIfAborted();
        if (readOnly) {
          assertReadOnlySql(args.text);
          return this.runReadOnlyStatement(args.text, args.values);
        }
        const result = await this.query(args.text, args.values);
        return result.rows;
      },
    });
  }

  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools);
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return executeFromRegistry(this.tools, name, args, signal);
  }

  toolkit(opts?: import("../../core/agent/types").ToolkitOptions) {
    return buildToolkitEntries(this.name, this.tools, opts);
  }

  /**
   * Returns the pool config for the current execution context.
   * Inside `asUser(req)`, returns user-scoped config; otherwise SP config.
   */
  private activePoolConfig() {
    const ctx = getUserContext();
    if (ctx) {
      const user = ctx.userEmail ?? ctx.userId;
      return { ...this.config.pool, workspaceClient: ctx.client, user };
    }
    return this.config.pool;
  }

  /**
   * Returns the plugin's public API, accessible via `AppKit.lakebase`.
   *
   * - `pool` — The connection pool (routes to per-user pool when inside `asUser(req)`)
   * - `query` — Convenience method for executing parameterized SQL queries
   * - `getOrmConfig()` — Returns a config object compatible with Drizzle, TypeORM, Sequelize, etc.
   *   Inside `asUser(req)`, returns user-scoped config.
   * - `getPgConfig()` — Returns a `pg.PoolConfig` object for manual pool construction.
   *   Inside `asUser(req)`, returns user-scoped config.
   *
   * Use `AppKit.lakebase.asUser(req)` to get the same API backed by a per-user pool.
   */
  exports() {
    return {
      // biome-ignore lint/style/noNonNullAssertion: pool is guaranteed non-null after setup(), which AppKit always awaits before exposing the plugin API
      pool: this.pool! as LakebasePool,
      query: this.query.bind(this),
      getOrmConfig: () => getLakebaseOrmConfig(this.activePoolConfig()),
      getPgConfig: () => getLakebasePgConfig(this.activePoolConfig()),
    };
  }
}

/**
 * @internal
 */
export const lakebase = toPlugin(LakebasePlugin);
