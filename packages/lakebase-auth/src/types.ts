import type { ConnectionOptions } from "node:tls";
import type { WorkspaceClient } from "@databricks/sdk-experimental";

/**
 * SSL configuration for a PostgreSQL connection.
 *
 * Structurally identical to `pg`'s `ssl` option (`boolean | tls.ConnectionOptions`),
 * so the result of {@link getPgConfig} can be passed directly to `pg`, `postgres.js`,
 * `Bun.SQL`, and other drivers without depending on `pg` here.
 */
export type SslConfig = boolean | ConnectionOptions;

/** Log severity levels emitted by the auth package. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Optional structured logging callback.
 *
 * The auth package has no logging dependency; instead it emits log events
 * through this callback when provided. Arguments follow `util.format`/`console`
 * semantics (a format string plus interpolation args).
 */
export type LogFn = (
  level: LogLevel,
  message: string,
  ...args: unknown[]
) => void;

/**
 * Token refresh strategy.
 *
 * - `"eager"` (default): fetch a token immediately and refresh it in the
 *   background before it expires, regardless of whether it is used. Best for
 *   time-sensitive, user-facing apps where the first query must be warm.
 * - `"lazy"`: fetch a token on first use and refresh it on demand when it
 *   nears expiry. Best for background jobs and infrequently-used connections.
 */
export type RefreshMode = "eager" | "lazy";

/**
 * Retry configuration for credential fetches.
 */
export interface RetryOptions {
  /**
   * Delays (in ms) between retry attempts; one retry per array entry. An empty
   * array disables retries.
   *
   * @default [50, 500, 5000]
   */
  schedule?: number[];
}

/**
 * Database credentials with OAuth token for Postgres connection.
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
 * Normalized credential with the expiry parsed to epoch milliseconds.
 * This is the shape returned by a {@link FetchCredential} function.
 */
export interface Credential {
  /** OAuth token to use as the Postgres password */
  token: string;
  /** Token expiration time as epoch milliseconds */
  expiresAt: number;
}

/**
 * A function that fetches a fresh credential. Used as the injectable seam that
 * lets consumers (e.g. `@databricks/lakebase`) wrap credential generation with
 * telemetry while keeping this package dependency-light.
 */
export type FetchCredential = () => Promise<Credential>;

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
   * Endpoint resource path. Retrieve using the Databricks CLI:
   * ```
   * databricks postgres list-endpoints projects/{project-id}/branches/{branch-id}
   * ```
   * Use the `name` field from the output.
   *
   * @example "projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}"
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

/**
 * Driver-agnostic configuration for Lakebase OAuth authentication.
 *
 * Supports two authentication methods:
 * 1. OAuth token authentication - Provide workspaceClient + endpoint (automatic token rotation)
 * 2. Native Postgres password authentication - Provide password string or function
 *
 * @see https://docs.databricks.com/aws/en/oltp/projects/authentication
 */
export interface LakebaseAuthConfig {
  /**
   * Databricks workspace client for OAuth authentication.
   * If not provided along with endpoint, the SDK default auth chain is used.
   *
   * Note: If password is provided, OAuth auth is not used.
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
   * Required for OAuth authentication (unless password is provided).
   * Can also be set via the LAKEBASE_ENDPOINT environment variable.
   *
   * @example "projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-identifier}"
   */
  endpoint?: string;

  /** PostgreSQL host. Can also be set via PGHOST. */
  host?: string;

  /** Database name. Can also be set via PGDATABASE. */
  database?: string;

  /** PostgreSQL username. Can also be set via PGUSER or DATABRICKS_CLIENT_ID. */
  user?: string;

  /** Port number. Can also be set via PGPORT. @default 5432 */
  port?: number;

  /**
   * SSL mode (convenience helper). Can also be set via PGSSLMODE.
   * @default "require"
   */
  sslMode?: "require" | "disable" | "prefer";

  /** Explicit SSL configuration; overrides {@link sslMode} when provided. */
  ssl?: SslConfig;

  /**
   * Native Postgres password (skips OAuth). A string or an (optionally async)
   * callback returning a password.
   */
  password?: string | (() => string | Promise<string>);

  /**
   * Optional UC claims for fine-grained table permissions on the generated
   * Postgres token.
   */
  claims?: RequestedClaims[];

  /**
   * Token refresh strategy.
   * @default "eager"
   */
  refresh?: RefreshMode;

  /**
   * How long before token expiry to refresh, in milliseconds.
   * @default 120000 (2 minutes)
   */
  earlyRefreshMs?: number;

  /** Retry options for transient credential-fetch failures. */
  retry?: RetryOptions;

  /** Optional structured logging callback. */
  onLog?: LogFn;
}
