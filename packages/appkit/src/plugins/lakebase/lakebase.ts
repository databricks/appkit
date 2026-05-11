import type { Pool, QueryResult, QueryResultRow } from "pg";
import type { AgentToolDefinition, ToolProvider } from "shared";
import { z } from "zod";
import {
  createLakebasePool,
  getLakebaseOrmConfig,
  getLakebasePgConfig,
  getUsernameWithApiLookup,
} from "../../connectors/lakebase";
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

/**
 * AppKit plugin for Databricks Lakebase Autoscaling.
 *
 * Wraps `@databricks/lakebase` to provide a standard `pg.Pool` with automatic
 * OAuth token refresh, integrated with AppKit's logger and OpenTelemetry setup.
 *
 * @example
 * ```ts
 * import { createApp, lakebase, server } from "@databricks/appkit";
 *
 * const AppKit = await createApp({
 *   plugins: [server(), lakebase()],
 * });
 *
 * const result = await AppKit.lakebase.query("SELECT * FROM users WHERE id = $1", [userId]);
 * ```
 */
export class LakebasePlugin extends Plugin implements ToolProvider {
  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"lakebase">;

  protected declare config: ILakebaseConfig;
  private pool: Pool | null = null;

  /**
   * Initializes the Lakebase connection pool.
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
   * Gracefully drains and closes the connection pool.
   * Called automatically by AppKit during shutdown.
   */
  abortActiveOperations(): void {
    super.abortActiveOperations();
    if (this.pool) {
      logger.info("Closing Lakebase pool");
      this.pool.end().catch((err) => {
        logger.error("Error closing Lakebase pool: %O", err);
      });
      this.pool = null;
    }
  }

  /**
   * Returns the plugin's public API, accessible via `AppKit.lakebase`.
   *
   * - `pool` — The raw `pg.Pool` instance, for use with ORMs or advanced scenarios
   * - `query` — Convenience method for executing parameterized SQL queries
   * - `getOrmConfig()` — Returns a config object compatible with Drizzle, TypeORM, Sequelize, etc.
   * - `getPgConfig()` — Returns a `pg.PoolConfig` object for manual pool construction
   */

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
        "Lakebase agent tool is enabled (readOnly=%s). Every agent with access to this plugin can execute SQL against the Lakebase database as the service principal.",
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
        ? "Execute a read-only SQL query against the Lakebase PostgreSQL database. Only SELECT, WITH, SHOW, EXPLAIN, and DESCRIBE statements are accepted. Use $1, $2, etc. as placeholders and pass values separately. Runs as the application's service principal."
        : "Execute a parameterized SQL statement against the Lakebase PostgreSQL database. Use $1, $2, etc. as placeholders and pass values separately. Runs as the application's service principal. This tool can modify data; every invocation requires explicit human approval.",
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
