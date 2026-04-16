import type { Pool, QueryResult, QueryResultRow } from "pg";
import type { AgentToolDefinition, ToolProvider } from "shared";
import { z } from "zod";
import {
  createLakebasePool,
  getLakebaseOrmConfig,
  getLakebasePgConfig,
  getUsernameWithApiLookup,
} from "../../connectors/lakebase";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import {
  defineTool,
  executeFromRegistry,
  toolsFromRegistry,
} from "../agent/tools/define-tool";
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
class LakebasePlugin extends Plugin implements ToolProvider {
  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = manifest as PluginManifest<"lakebase">;

  protected declare config: ILakebaseConfig;
  private pool: Pool | null = null;

  constructor(config: ILakebaseConfig) {
    super(config);
    this.config = config;
  }

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

  private tools = {
    query: defineTool({
      description:
        "Execute a parameterized SQL query against the Lakebase PostgreSQL database. Use $1, $2, etc. as placeholders and pass values separately.",
      schema: z.object({
        text: z
          .string()
          .describe(
            "SQL query string with $1, $2, ... placeholders for parameters",
          ),
        values: z
          .array(z.unknown())
          .optional()
          .describe("Parameter values corresponding to placeholders"),
      }),
      annotations: {
        readOnly: false,
        destructive: false,
        idempotent: false,
      },
      handler: async (args) => {
        const result = await this.query(args.text, args.values);
        return result.rows;
      },
    }),
  };

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
