import type { PoolConfig } from "pg";

import { getUsernameSync, parsePoolConfig } from "./config";
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
 * Resolve the connection lifetime, keeping an explicit 0 (never recycle), and
 * warn when connections could outlive a token's Unity Catalog claims.
 *
 * pg-pool closes a connection right after it opens when the lifetime is
 * negative, and never recycles it when the lifetime is NaN, so an invalid
 * value falls back to the default instead of reaching pg-pool.
 */
function resolveMaxLifetimeSeconds(
  userConfig: Partial<LakebasePoolConfig>,
  logger?: Logger,
): number {
  const maxLifetimeSeconds =
    userConfig.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;

  if (!Number.isFinite(maxLifetimeSeconds) || maxLifetimeSeconds < 0) {
    logger?.warn(
      "maxLifetimeSeconds must be a number of seconds, 0 or more, but is %s. Using the default of %d seconds.",
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
 * ```
 */
export function getLakebaseOrmConfig(config?: Partial<LakebasePoolConfig>) {
  const { user, password, ssl, ...pgConfig } = getLakebasePgConfig(config);

  return {
    ...pgConfig,
    username: user,
    password: password as
      | string
      | (() => string)
      | (() => Promise<string>)
      | undefined,
    ssl: ssl
      ? typeof ssl === "boolean"
        ? ssl
        : { rejectUnauthorized: ssl.rejectUnauthorized }
      : false,
  };
}
