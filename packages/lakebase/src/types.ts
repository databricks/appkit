import type {
  RefreshMode,
  RequestedClaims,
  RetryOptions,
} from "@databricks/lakebase-auth";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { PoolConfig } from "pg";

// Re-export the auth/credential types so existing `@databricks/lakebase`
// imports keep working after the split into `@databricks/lakebase-auth`.
export type {
  Credential,
  DatabaseCredential,
  GenerateDatabaseCredentialRequest,
  RefreshMode,
  RequestedClaims,
  RequestedResource,
  RetryOptions,
} from "@databricks/lakebase-auth";
export { RequestedClaimsPermissionSet } from "@databricks/lakebase-auth";

/**
 * Optional logger interface for the Lakebase driver.
 * When not provided, the driver operates silently (no logging).
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Configuration for console-based logger.
 * Specify which log levels should be enabled.
 */
export interface LoggerConfig {
  /** Enable debug level logging */
  debug?: boolean;
  /** Enable info level logging */
  info?: boolean;
  /** Enable warning level logging */
  warn?: boolean;
  /** Enable error level logging */
  error?: boolean;
}

/**
 * Telemetry configuration options
 */
export type TelemetryOptions =
  | boolean
  | {
      traces?: boolean;
      metrics?: boolean;
    };

/**
 * Configuration for creating a Lakebase connection pool
 *
 * Supports two authentication methods:
 * 1. OAuth token authentication - Provide workspaceClient + endpoint (automatic token rotation)
 * 2. Native Postgres password authentication - Provide password string or function
 *
 * Extends pg.PoolConfig to support all standard PostgreSQL pool options.
 *
 * @see https://docs.databricks.com/aws/en/oltp/projects/authentication
 */
export interface LakebasePoolConfig extends PoolConfig {
  /**
   * Databricks workspace client for OAuth authentication
   * If not provided along with endpoint, will attempt to use ServiceContext
   *
   * Note: If password is provided, OAuth auth is not used
   */
  workspaceClient?: WorkspaceClient;

  /**
   * Endpoint resource path for OAuth token generation.
   *
   * Retrieve the value using the Databricks CLI:
   * ```
   * databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}
   * ```
   * Use the `name` field from the output.
   *
   * Required for OAuth authentication (unless password is provided)
   * Can also be set via LAKEBASE_ENDPOINT environment variable
   *
   * @example "projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}"
   */
  endpoint?: string;

  /**
   * SSL mode for the connection (convenience helper). Can also be set via
   * PGSSLMODE. All values other than "disable" are treated as "verify-full"
   * with system root certs.
   *
   * @default "verify-full"
   */
  sslMode?: "verify-full" | "verify-ca" | "require" | "prefer" | "disable";

  /**
   * Optional UC claims for fine-grained Unity Catalog table permissions on the
   * generated Postgres token.
   */
  claims?: RequestedClaims[];

  /**
   * Token refresh strategy.
   *
   * - `"eager"` (default): fetch a token immediately and refresh it in the
   *   background before it expires. Best for time-sensitive, user-facing apps.
   * - `"lazy"`: fetch a token on first use and refresh it on demand.
   *
   * @default "eager"
   */
  refresh?: RefreshMode;

  /**
   * How long before token expiry to refresh, in milliseconds.
   *
   * @default 120000 (2 minutes)
   */
  earlyRefreshMs?: number;

  /**
   * Retry options for transient credential-fetch failures (e.g. the OAuth
   * server being briefly unreachable).
   *
   * @default { schedule: [50, 500, 5000] }
   */
  retry?: RetryOptions;

  /**
   * Telemetry configuration
   *
   * - `true` or omitted: enable all telemetry (traces, metrics) -- no-op when OTEL is not configured
   * - `false`: disable all telemetry
   * - `{ traces?, metrics? }`: fine-grained control
   */
  telemetry?: TelemetryOptions;

  /**
   * Optional logger configuration.
   *
   * Supports three modes:
   * 1. Logger instance - Use your own logger implementation
   * 2. LoggerConfig - Enable/disable specific log levels (uses console)
   * 3. Undefined - Defaults to error logging only
   *
   * @example Using custom logger
   * ```typescript
   * import { createLogger } from '@databricks/appkit';
   * const pool = createLakebasePool({
   *   logger: createLogger('connectors:lakebase')
   * });
   * ```
   *
   * @example Using config-based logger
   * ```typescript
   * const pool = createLakebasePool({
   *   logger: { debug: true, info: true, error: true }
   * });
   * ```
   */
  logger?: Logger | LoggerConfig;
}
