import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { PoolConfig } from "pg";

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
   * All segments are IDs assigned by Databricks (not names you create):
   * - project-id: UUID format (e.g., `a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789`)
   * - branch-id: Identifier from Databricks (e.g., `main`, `dev`)
   * - endpoint-id: Identifier from Databricks (e.g., `primary`, `analytics`)
   *
   * Format: `projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}`
   *
   * Required for OAuth authentication (unless password is provided)
   * Can also be set via LAKEBASE_ENDPOINT environment variable
   *
   * @example "projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-sparkling-tree-y17uj7fn/endpoints/ep-restless-pine-y1ldaht0"
   */
  endpoint?: string;

  /**
   * SSL mode for the connection (convenience helper)
   * Can also be set via PGSSLMODE environment variable
   *
   * @default "require"
   */
  sslMode?: "require" | "disable" | "prefer";

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

// ---------------------------------------------------------------------------
// Authentication types for Lakebase Postgres OAuth token generation
// @see https://docs.databricks.com/aws/en/oltp/projects/authentication
// ---------------------------------------------------------------------------

/**
 * Database credentials with OAuth token for Postgres connection
 */
export interface DatabaseCredential {
  /** OAuth token to use as the password when connecting to Postgres */
  token: string;

  /**
   * Token expiration time in UTC (ISO 8601 format)
   * Tokens expire after 1 hour from generation
   * @example "2026-02-06T17:07:00Z"
   */
  expire_time: string;
}

/**
 * Permission set for Unity Catalog table access
 */
export enum RequestedClaimsPermissionSet {
  /**
   * Read-only access to specified UC tables
   */
  READ_ONLY = "READ_ONLY",
}

/**
 * Resource to request permissions for in Unity Catalog
 */
export interface RequestedResource {
  /**
   * Unity Catalog table name to request access to
   * @example "catalog.schema.table"
   */
  table_name?: string;

  /**
   * Generic resource name for non-table resources
   */
  unspecified_resource_name?: string;
}

/**
 * Optional claims for fine-grained Unity Catalog table permissions
 * When specified, the returned token will be scoped to only the requested tables
 */
export interface RequestedClaims {
  /**
   * Permission level to request
   */
  permission_set?: RequestedClaimsPermissionSet;

  /**
   * List of UC resources to request access to
   */
  resources?: RequestedResource[];
}

/**
 * Request parameters for generating database OAuth credentials
 */
export interface GenerateDatabaseCredentialRequest {
  /**
   * Endpoint resource path with IDs assigned by Databricks.
   *
   * All segments are IDs from Databricks (not names you create):
   * - project-id: UUID format (e.g., `a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789`)
   * - branch-id: Identifier from Databricks (e.g., `main`, `dev`)
   * - endpoint-id: Identifier from Databricks (e.g., `primary`, `analytics`)
   *
   * Format: `projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}`
   *
   * **Important:** Copy from Databricks Lakebase UI - do not construct manually.
   *
   * @example "projects/6bef4151-4b5d-4147-b4d0-c2f4fd5b40db/branches/br-sparkling-tree-y17uj7fn/endpoints/ep-restless-pine-y1ldaht0"
   */
  endpoint: string;

  /**
   * Optional claims for fine-grained UC table permissions.
   * When specified, the token will only grant access to the specified tables.
   *
   * @example
   * ```typescript
   * {
   *   claims: [{
   *     permission_set: RequestedClaimsPermissionSet.READ_ONLY,
   *     resources: [{ table_name: "catalog.schema.users" }]
   *   }]
   * }
   * ```
   */
  claims?: RequestedClaims[];
}
