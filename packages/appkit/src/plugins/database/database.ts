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
    if (process.env.APPKIT_DEBUG_POOL || process.env.DEBUG_POOL) {
      startPoolStatsLog(this.pool, "service-principal");
    }
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
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        "Database schema load failed (config/database/schema.ts): %s",
        message,
      );
      if (!this.config.tolerateSetupFailure) {
        const stalePool = this.pool;
        this.pool = null;
        if (stalePool) {
          await stalePool.end().catch((endErr) => {
            logger.error(
              "Error draining stale pool after schema-load failure: %O",
              endErr,
            );
          });
        }
        throw err;
      }
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
 * Attach a `connect` listener that sets per-session defaults on
 * every new Postgres session checked out of the pool
 * @param pool
 * @param override
 */
function attachSessionDefaults(pool: Pool, override?: number): void {
  const ms = override ?? STATEMENT_TIMEOUT_DEFAULT_MS;
  const applicationName = applicationNameForSession();
  pool.on("connect", (client) => {
    let destroyed = false;
    const destroy = (label: string, err: unknown) => {
      if (destroyed) return;
      destroyed = true;
      logger.error(
        "Failed to set %s on pool connection; destroying client to prevent unguarded use: %O",
        label,
        err,
      );
      // `release(true)` removes the client from the pool entirely. pg will
      // build a fresh connection on next acquire and re-fire `connect`.
      const maybeRelease = (
        client as unknown as { release?: (destroy?: boolean) => void }
      ).release;
      try {
        maybeRelease?.call(client, true);
      } catch (releaseErr) {
        logger.error("Failed to destroy pool client: %O", releaseErr);
      }
    };
    client
      .query(`SET application_name = '${applicationName}'`)
      .catch((err) => destroy("application_name", err));
    if (Number.isFinite(ms) && ms > 0) {
      client
        .query(`SET statement_timeout = ${Math.floor(ms)}`)
        .catch((err) => destroy("statement_timeout", err));
    }
  });
}

/**
 * Build a per-session `application_name` string.
 */
function applicationNameForSession(): string {
  const appName = process.env.DATABRICKS_APP_NAME;
  // Sanitize: only allow common identifier characters in the discriminator.
  const safeAppName = appName?.replace(/[^A-Za-z0-9._-]/g, "_") ?? "";
  const composed = safeAppName
    ? `${APPLICATION_NAME}:${safeAppName}`
    : APPLICATION_NAME;
  return composed.slice(0, 60);
}

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
