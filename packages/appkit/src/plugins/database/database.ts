import type { Pool } from "pg";
import { Plugin, toPlugin } from "@/plugin";
import { createLakebasePool } from "../../connectors/lakebase";
import type { Schema } from "../../database";
import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { PluginManifest } from "../../registry";
import { loadSchemaByConvention } from "./convention";
import {
  APPLICATION_NAME,
  POOL_DEFAULTS,
  STATEMENT_TIMEOUT_DEFAULT_MS,
} from "./defaults";
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
    attachSessionDefaults(this.pool, this.config.statementTimeoutMs);
    if (process.env.DEBUG_POOL)
      startPoolStatsLog(this.pool, "service-principal");
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
 * Attach a `connect` listener that sets per-session defaults on every new
 * Postgres session checked out of the pool: `statement_timeout` (caps runaway
 * queries even when the client signal is dropped) and `application_name` (so
 * the connection is attributable in `pg_stat_activity`).
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
 * When `DEBUG_POOL=1` is set, periodically log the pool's
 * total/idle/waiting connection counts so operators can observe saturation.
 * The interval is unrefed so it never blocks shutdown.
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
