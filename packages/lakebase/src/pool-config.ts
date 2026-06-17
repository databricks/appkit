import {
  type Credential,
  type FetchCredential,
  generateDatabaseCredential,
  getPgConfig,
  getWorkspaceClient,
  type LogFn,
} from "@databricks/lakebase-auth";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { PoolConfig } from "pg";
import {
  type DriverTelemetry,
  initTelemetry,
  SpanStatusCode,
} from "./telemetry";
import type { LakebasePoolConfig, Logger } from "./types";

/** Default pool sizing values for the Lakebase connector */
const poolDefaults = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
};

/** Bridge a {@link Logger} to the auth package's structured `onLog` callback. */
export function loggerToOnLog(logger?: Logger): LogFn | undefined {
  if (!logger) return undefined;
  return (level, message, ...args) => logger[level](message, ...args);
}

/**
 * Build a credential fetcher that wraps {@link generateDatabaseCredential} with
 * OpenTelemetry tracing/metrics and logger integration. Injected into the auth
 * package's password provider so observability stays in `@databricks/lakebase`.
 */
export function createTelemetryFetchCredential(deps: {
  userConfig: Partial<LakebasePoolConfig>;
  endpoint: string;
  telemetry: DriverTelemetry;
  logger?: Logger;
}): FetchCredential {
  // Lazily initialize the workspace client on first password fetch.
  let workspaceClient: WorkspaceClient | null =
    deps.userConfig.workspaceClient ?? null;

  return async (): Promise<Credential> => {
    if (!workspaceClient) {
      try {
        workspaceClient = getWorkspaceClient(deps.userConfig);
      } catch (error) {
        deps.logger?.error("Failed to initialize workspace client: %O", error);
        throw error;
      }
    }
    const client = workspaceClient;

    const startTime = Date.now();
    try {
      return await deps.telemetry.tracer.startActiveSpan(
        "lakebase.token.refresh",
        { attributes: { "lakebase.endpoint": deps.endpoint } },
        async (span) => {
          const credential = await generateDatabaseCredential(client, {
            endpoint: deps.endpoint,
            ...(deps.userConfig.claims
              ? { claims: deps.userConfig.claims }
              : {}),
          });
          const expiresAt = new Date(credential.expire_time).getTime();
          span.setAttribute(
            "lakebase.token.expires_at",
            new Date(expiresAt).toISOString(),
          );
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return { token: credential.token, expiresAt };
        },
      );
    } catch (error) {
      deps.logger?.error("Failed to fetch OAuth token: %O", {
        error,
        message: error instanceof Error ? error.message : String(error),
        endpoint: deps.endpoint,
      });
      throw error;
    } finally {
      deps.telemetry.tokenRefreshDuration.record(Date.now() - startTime);
    }
  };
}

/**
 * Build the Lakebase `pg.PoolConfig` along with a disposer that stops the
 * background token refresh (used by {@link createLakebasePool} to clean up on
 * `pool.end()`).
 */
export function buildLakebasePgConfig(
  config?: Partial<LakebasePoolConfig>,
  telemetry?: DriverTelemetry,
  logger?: Logger,
): { poolConfig: PoolConfig; dispose: () => void } {
  const userConfig = config ?? {};
  const onLog = loggerToOnLog(logger);

  // Resolve the endpoint (with env fallback) so the telemetry-wrapped fetcher
  // is used for OAuth auth regardless of whether the endpoint came from config
  // or LAKEBASE_ENDPOINT. When neither endpoint nor password is set, getPgConfig
  // below throws the appropriate configuration error.
  const endpoint = userConfig.endpoint ?? process.env.LAKEBASE_ENDPOINT;

  // Only wrap with telemetry when using OAuth (no native password provided).
  const fetchCredential =
    userConfig.password === undefined && endpoint !== undefined
      ? createTelemetryFetchCredential({
          userConfig,
          endpoint,
          telemetry: telemetry ?? initTelemetry(),
          logger,
        })
      : undefined;

  const { dispose, ...pg } = getPgConfig({
    ...userConfig,
    fetchCredential,
    onLog,
  });

  const poolConfig: PoolConfig = {
    host: pg.host,
    port: pg.port,
    user: pg.user,
    database: pg.database,
    password: pg.password,
    ssl: pg.ssl,
    max: userConfig.max ?? poolDefaults.max,
    idleTimeoutMillis:
      userConfig.idleTimeoutMillis ?? poolDefaults.idleTimeoutMillis,
    connectionTimeoutMillis:
      userConfig.connectionTimeoutMillis ??
      poolDefaults.connectionTimeoutMillis,
  };

  return { poolConfig, dispose };
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
  return buildLakebasePgConfig(config, telemetry, logger).poolConfig;
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
