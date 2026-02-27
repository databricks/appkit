import type { PoolConfig } from "pg";
import { getUsernameSync, parsePoolConfig } from "./config";
import { type DriverTelemetry, initTelemetry } from "./telemetry";
import { createTokenRefreshCallback } from "./token-refresh";
import type { LakebasePoolConfig, Logger } from "./types";

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
