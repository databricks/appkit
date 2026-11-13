import type { PoolConfig } from "pg";

import { getUsernameSync, parsePoolConfig } from "./config";
import { resolveLogger } from "./logger";
import { type DriverTelemetry, initTelemetry } from "./telemetry";
import { createTokenRefreshCallback } from "./token-refresh";
import type { LakebasePoolConfig, Logger } from "./types";

/** Default connection lifetime: 30 minutes. */
const DEFAULT_MAX_LIFETIME_SECONDS = 30 * 60;

/**
 * Longest connection lifetime that's safe for OAuth tokens. Access granted
 * through Unity Catalog claims stops working 4 hours after a token is minted
 * (observed on a live endpoint; the connection stays open, and queries fail
 * with "permission denied"). Lakebase rejects expired tokens at login, so a
 * token is at most an hour old when a connection opens. That leaves 3 hours,
 * less a 30-minute margin for a client held past its lifetime, login time and
 * clock skew.
 */
const MAX_SAFE_LIFETIME_SECONDS = 4 * 3600 - 3600 - 30 * 60;

/**
 * Longest delay Node's `setTimeout` accepts (about 24.8 days). pg-pool passes
 * `maxLifetimeSeconds * 1000` to it, and a longer delay fires after 1 ms, so
 * every connection would close after a single use.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Resolve the connection lifetime, keeping an explicit 0 (never recycle), and
 * warn when connections could outlive a token's Unity Catalog claims.
 *
 * pg-pool closes a connection right after it opens when the lifetime is
 * negative or overflows Node's timer, and never recycles it when the lifetime
 * is NaN, so an invalid value falls back to the default instead of reaching
 * pg-pool.
 */
function resolveMaxLifetimeSeconds(
  userConfig: Partial<LakebasePoolConfig>,
  logger?: Logger,
): number {
  const maxLifetimeSeconds =
    userConfig.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;

  if (
    !Number.isFinite(maxLifetimeSeconds) ||
    maxLifetimeSeconds < 0 ||
    maxLifetimeSeconds * 1000 > MAX_TIMER_MS
  ) {
    logger?.warn(
      "maxLifetimeSeconds must be a number of seconds from 0 to %d, but is %s. Using the default of %d seconds.",
      Math.floor(MAX_TIMER_MS / 1000),
      String(maxLifetimeSeconds),
      DEFAULT_MAX_LIFETIME_SECONDS,
    );
    return DEFAULT_MAX_LIFETIME_SECONDS;
  }

  if (maxLifetimeSeconds === 0) {
    logger?.warn(
      "maxLifetimeSeconds is 0, so pool connections are never recycled. Access granted through Unity Catalog claims in the OAuth token can stop working on connections that stay open for hours. Set a lifetime of at most %d seconds.",
      MAX_SAFE_LIFETIME_SECONDS,
    );
  } else if (maxLifetimeSeconds > MAX_SAFE_LIFETIME_SECONDS) {
    logger?.warn(
      "maxLifetimeSeconds is %d. Access granted through Unity Catalog claims in the OAuth token can stop working on connections that live this long. Use at most %d seconds.",
      maxLifetimeSeconds,
      MAX_SAFE_LIFETIME_SECONDS,
    );
  }

  return maxLifetimeSeconds;
}

/**
 * Map an SSL mode string to the corresponding `pg` SSL configuration.
 *
 * - `"require"` -- SSL enabled with certificate verification
 * - `"prefer"`  -- SSL enabled without certificate verification (try SSL, accept any cert)
 * - `"disable"` -- SSL disabled
 */
function mapSslConfig(
  sslMode: "require" | "prefer" | "disable",
): PoolConfig["ssl"] {
  switch (sslMode) {
    case "require":
      return { rejectUnauthorized: true };
    case "prefer":
      return { rejectUnauthorized: false };
    case "disable":
      return false;
  }
}

/**
 * Get Lakebase connection configuration for PostgreSQL clients.
 *
 * Returns pg.PoolConfig with OAuth token authentication configured.
 * Best used with pg.Pool directly or ORMs that accept pg.Pool instances (like Drizzle).
 *
 * For ORMs that need connection parameters (TypeORM, Sequelize), use getLakebaseOrmConfig() instead.
 *
 * Used internally by createLakebasePool().
 *
 * @param config - Optional configuration (reads from environment if not provided)
 * @param telemetry - Optional pre-initialized telemetry (created internally if not provided)
 * @param logger - Optional logger (silent if not provided)
 * @returns PostgreSQL pool configuration with OAuth token refresh
 */
export function getLakebasePgConfig(
  config?: Partial<LakebasePoolConfig>,
  telemetry?: DriverTelemetry,
  logger?: Logger,
): PoolConfig {
  const userConfig = config ?? {};
  const poolConfig = parsePoolConfig(userConfig);
  const username = getUsernameSync(userConfig);

  let passwordConfig: string | (() => string | Promise<string>) | undefined;

  if (userConfig.password !== undefined) {
    passwordConfig = userConfig.password;
  } else if (poolConfig.endpoint) {
    // endpoint is guaranteed here -- parsePoolConfig() throws if
    // neither endpoint nor password is provided
    passwordConfig = createTokenRefreshCallback({
      userConfig,
      endpoint: poolConfig.endpoint,
      telemetry: telemetry ?? initTelemetry(),
      logger,
    });
  }

  return {
    host: poolConfig.host,
    port: poolConfig.port,
    user: username,
    database: poolConfig.database,
    password: passwordConfig,
    ssl: poolConfig.ssl ?? mapSslConfig(poolConfig.sslMode),
    max: poolConfig.max,
    idleTimeoutMillis: poolConfig.idleTimeoutMillis,
    connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
    statement_timeout: userConfig.statement_timeout,
    idle_in_transaction_session_timeout:
      userConfig.idle_in_transaction_session_timeout,
    maxLifetimeSeconds: resolveMaxLifetimeSeconds(userConfig, logger),
    application_name: userConfig.application_name,
    keepAlive: userConfig.keepAlive,
    query_timeout: userConfig.query_timeout,
    options: userConfig.options,
  };
}

/**
 * `T` after `definedOnly`: keys whose value can be undefined become optional
 * (and no longer include undefined); keys that are always set stay required.
 */
type DefinedOnly<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

/** Drop undefined values, so they don't override an ORM's own defaults. */
function definedOnly<T extends object>(values: T): DefinedOnly<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as DefinedOnly<T>;
}

/**
 * Age-based connection recycling for Sequelize, whose pool (sequelize-pool)
 * has no lifetime option.
 *
 * `afterConnect` records when each connection opens. sequelize-pool calls
 * `validate` whenever it reuses an idle connection and destroys the
 * connection when it returns false, so a connection older than the lifetime
 * is replaced by a new one. As with pg-pool, a connection that's checked out
 * isn't closed until it's released.
 */
function createSequelizeLifetimeCheck(
  maxLifetimeSeconds: number,
  logger?: Logger,
) {
  const openedAt = new WeakMap<object, number>();
  const lifetimeMs = maxLifetimeSeconds * 1000;
  let warnedMissingHook = false;

  return {
    afterConnect(connection: unknown): void {
      if (typeof connection === "object" && connection !== null) {
        openedAt.set(connection, Date.now());
      }
    },
    validate(connection?: unknown): boolean {
      if (typeof connection !== "object" || connection === null) {
        return false;
      }
      // A custom validate replaces Sequelize's own check, so repeat it.
      const client = connection as { _invalid?: boolean; _ending?: boolean };
      if (client._invalid || client._ending) {
        return false;
      }
      if (lifetimeMs === 0) {
        return true;
      }
      const opened = openedAt.get(connection);
      if (opened === undefined) {
        // afterConnect didn't run, so the caller replaced `hooks` with their
        // own. Start the clock at this first reuse instead. Rejecting the
        // connection would be worse: no connection would ever have an open
        // time, so every reuse would open a new one.
        if (!warnedMissingHook) {
          warnedMissingHook = true;
          logger?.warn(
            "The afterConnect hook from getLakebaseOrmConfig() isn't registered, so connection lifetimes are measured from first reuse rather than from when connections open. Merge your hooks with the returned `hooks` instead of replacing them.",
          );
        }
        openedAt.set(connection, Date.now());
        return true;
      }
      return Date.now() - opened < lifetimeMs;
    },
  };
}

/**
 * Get Lakebase connection configuration for ORMs that don't accept pg.Pool directly.
 *
 * Designed for ORMs like TypeORM and Sequelize that need connection parameters
 * rather than a pre-configured pool instance.
 *
 * Returns connection config with field names compatible with common ORMs:
 * - `username` instead of `user`
 * - Simplified SSL config
 * - Password callback support for OAuth token refresh
 *
 * Pool and client settings (connection lifetime, pool size, timeouts, SSL)
 * are also returned where each ORM reads them, so recycling works with both:
 * - TypeORM: pool size, connect timeout and application name under its own
 *   `poolSize`, `connectTimeoutMS` and `applicationName`, so values you set
 *   after the spread still win. Everything else (lifetime, idle timeout,
 *   statement and query timeouts) goes under `extra`, which TypeORM merges
 *   into the `pg.Pool` options last.
 * - Sequelize: `dialectOptions` (passed to each `pg.Client`), `pool`, and
 *   `hooks`. Sequelize's pool has no lifetime option, so connections are
 *   recycled by age through `pool.validate` and an `afterConnect` hook.
 *
 * The result carries keys for both ORMs, and each ignores the other's:
 * Sequelize ignores `poolSize`, `connectTimeoutMS`, `applicationName` and
 * `extra`, and TypeORM ignores `dialectOptions`, `pool` and `hooks`.
 *
 * If you set your own `extra`, `pool`,
 * `dialectOptions` or `hooks`, merge them with these instead of replacing
 * them, or those settings are lost. Replacing `hooks` makes lifetimes count
 * from a connection's first reuse instead of when it opened, and logs a
 * warning if you passed a `logger`. Nothing is logged without one.
 *
 * @param config - Optional configuration (reads from environment if not provided)
 * @returns ORM-compatible connection configuration
 *
 * @example
 * ```typescript
 * // TypeORM
 * const dataSource = new DataSource({
 *   type: 'postgres',
 *   ...getLakebaseOrmConfig(),
 *   entities: [User],
 *   synchronize: true,
 * });
 *
 * // Sequelize
 * const sequelize = new Sequelize({
 *   dialect: 'postgres',
 *   ...getLakebaseOrmConfig(),
 *   logging: false,
 * });
 *
 * // Adding your own settings: merge, don't replace
 * const ormConfig = getLakebaseOrmConfig();
 * const sequelize = new Sequelize({
 *   dialect: 'postgres',
 *   ...ormConfig,
 *   pool: { ...ormConfig.pool, min: 2 },
 * });
 * ```
 */
export function getLakebaseOrmConfig(config?: Partial<LakebasePoolConfig>) {
  // Log only when the caller configured a logger. resolveLogger(undefined)
  // would return a console logger for errors, which would print token-fetch
  // failures that this function has never printed.
  const logger = config?.logger ? resolveLogger(config.logger) : undefined;
  const { user, password, ssl, ...pgConfig } = getLakebasePgConfig(
    config,
    undefined,
    logger,
  );

  const ormSsl = ssl
    ? typeof ssl === "boolean"
      ? ssl
      : { rejectUnauthorized: ssl.rejectUnauthorized }
    : false;

  // Settings pg.Client reads that TypeORM has no option of its own for.
  // Neither ORM forwards these from the top level.
  const clientOptions = definedOnly({
    keepAlive: pgConfig.keepAlive,
    statement_timeout: pgConfig.statement_timeout,
    query_timeout: pgConfig.query_timeout,
    idle_in_transaction_session_timeout:
      pgConfig.idle_in_transaction_session_timeout,
    options: pgConfig.options,
  });

  const lifetimeCheck = createSequelizeLifetimeCheck(
    pgConfig.maxLifetimeSeconds ?? 0,
    logger,
  );

  return {
    ...pgConfig,
    username: user,
    password: password as
      | string
      | (() => string)
      | (() => Promise<string>)
      | undefined,
    ssl: ormSsl,
    // TypeORM. Settings it has its own option for go under that option, so
    // a value the caller sets after the spread still wins: TypeORM applies
    // `extra` last, over its own options.
    poolSize: pgConfig.max,
    connectTimeoutMS: pgConfig.connectionTimeoutMillis,
    applicationName: pgConfig.application_name,
    extra: definedOnly({
      ...clientOptions,
      idleTimeoutMillis: pgConfig.idleTimeoutMillis ?? undefined,
      maxLifetimeSeconds: pgConfig.maxLifetimeSeconds,
    }),
    // Sequelize
    dialectOptions: definedOnly({
      ...clientOptions,
      application_name: pgConfig.application_name,
      connectionTimeoutMillis: pgConfig.connectionTimeoutMillis,
      ssl: ormSsl,
    }),
    pool: definedOnly({
      max: pgConfig.max,
      // @types/pg allows null here; Sequelize's types don't.
      idle: pgConfig.idleTimeoutMillis ?? undefined,
      validate: lifetimeCheck.validate,
    }),
    hooks: { afterConnect: lifetimeCheck.afterConnect },
  };
}
