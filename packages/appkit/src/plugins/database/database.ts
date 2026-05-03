import type { Pool } from "pg";
import type { IAppRouter } from "shared";
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
import type { EntityClient, ExecutorFn } from "./entity-proxy";
import { wireEntities } from "./entity-wiring";
import manifest from "./manifest.json";
import { RouteGenerator } from "./route-generator";
import type { HttpAccess, IDatabaseConfig } from "./types";

const logger = createLogger("database");

type DatabaseExports = {
  [entity: string]: EntityClient | (() => Pool);
  getPool: () => Pool;
};

class DatabasePlugin extends Plugin<IDatabaseConfig> {
  static manifest = manifest as PluginManifest<"database">;

  protected declare config: IDatabaseConfig;
  protected pool: Pool | null = null;
  protected schema: Schema | null = null;
  protected schemaPath: string | null = null;
  protected entities: Record<string, EntityClient> = {};

  constructor(config: IDatabaseConfig = {}) {
    super(config);
    this.config = config;
  }

  async setup() {
    // Service-principal pool. Same factory the standalone `lakebase` plugin
    // uses — Lakebase OAuth refresh is built in. Dev = current user OAuth,
    // prod = SP OAuth, both transparent.
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

      // Wiring builds an EntityClient per table on top of the SP pool, plus a
      // per-user pool registry used by `EntityClient.asUser(req)` for OBO.
      const executor: ExecutorFn = async (fn, options) => {
        const result = await this.execute(fn, options);
        if (!result.ok) throw new Error(result.message);
        return result.data;
      };

      const wired = wireEntities({
        schema: this.schema,
        config: this.config,
        servicePool: this.pool,
        executor,
      });

      this.entities = wired.entities;
      logger.info(
        "Database entity API wired for: %s",
        Object.keys(this.entities).join(", "),
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

  injectRoutes(router: IAppRouter): void {
    if (!this.schema) return;

    new RouteGenerator({
      schema: this.schema,
      config: this.config,
      getSurface: (req, access) => this.getSurface(req, access),
      route: (target, config) => this.route(target, config),
    }).injectAll(router);
  }

  asUser(req: import("express").Request): this {
    const baseProxy = super.asUser(req);

    // Dev fallback: when no OBO header is present and we're in dev, return
    // the SP-backed proxy so the dev loop stays unbroken. Mirrors the entity
    // client's own asUser fallback.
    const email = req.header("x-forwarded-email");
    if (!email && process.env.NODE_ENV === "development") {
      return baseProxy;
    }

    const userEntities: Record<string, EntityClient> = {};
    for (const [name, client] of Object.entries(this.entities)) {
      userEntities[name] = client.asUser(req);
    }

    const userExports = (): DatabaseExports => ({
      ...userEntities,
      getPool: () => this.requirePool(),
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

    await Promise.all(drains);
  }

  exports(): DatabaseExports {
    return {
      ...this.entities,
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
