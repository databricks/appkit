import type { Pool } from "pg";
import { Plugin, toPlugin } from "@/plugin";
import { createLakebasePool } from "../../connectors/lakebase";
import type { Schema } from "../../database";
import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { PluginManifest } from "../../registry";
import { loadSchemaByConvention } from "./convention";
import { POOL_DEFAULTS, STATEMENT_TIMEOUT_DEFAULT_MS } from "./defaults";
import manifest from "./manifest.json";
import type { IDatabaseConfig } from "./types";

const logger = createLogger("database");

class DatabasePlugin extends Plugin<IDatabaseConfig> {
  static manifest = manifest as PluginManifest<"database">;

  protected declare config: IDatabaseConfig;
  protected pool: Pool | null = null;
  protected schema: Schema | null = null;
  protected schemaPath: string | null = null;

  constructor(config: IDatabaseConfig = {}) {
    super(config);
    this.config = config;
  }

  async setup() {
    this.pool = createLakebasePool({
      ...POOL_DEFAULTS,
      ...this.config.connection,
    });
    attachStatementTimeout(this.pool, this.config.statementTimeoutMs);
    logger.info("Database plugin pool initialized");

    try {
      const loaded = await loadSchemaByConvention();
      if (!loaded) {
        logger.warn(
          "Database plugin did not find config/database/schema.ts, using empty schema",
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
    } catch (err) {
      // A throwing schema-load otherwise cascades through Promise.all in core
      // and crashes every plugin's boot. Decorate the error with the
      // convention path so the operator can find it, then re-raise unless the
      // caller opted into tolerant boot.
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        "Database schema load failed (config/database/schema.ts): %s",
        message,
      );
      if (!this.config.tolerateSetupFailure) throw err;
    }
  }

  async abortActiveOperations(): Promise<void> {
    super.abortActiveOperations();
    if (!this.pool) return;

    logger.info("Closing database pool");
    const draining = this.pool.end();
    this.pool = null;
    try {
      await draining;
    } catch (err) {
      logger.error("Error closing database pool: %O", err);
    }
  }

  exports() {
    return {
      getPool: () => this.requirePool(),
    };
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
}

export const database = toPlugin(DatabasePlugin);

/**
 * Attach a `connect` listener that sets `statement_timeout` on every new
 * Postgres session checked out of the pool. Caps runaway queries server-side
 * even when the client signal is dropped.
 */
function attachStatementTimeout(pool: Pool, override?: number): void {
  const ms = override ?? STATEMENT_TIMEOUT_DEFAULT_MS;
  if (!Number.isFinite(ms) || ms <= 0) return;
  pool.on("connect", (client) => {
    client.query(`SET statement_timeout = ${Math.floor(ms)}`).catch((err) => {
      logger.error(
        "Failed to set statement_timeout on pool connection: %O",
        err,
      );
    });
  });
}
