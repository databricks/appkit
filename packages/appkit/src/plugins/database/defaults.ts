import type { PluginExecuteConfig } from "shared";

/**
 * Connection pool defaults for the service-principal pool.
 * 10 connections in the pool at maximum
 * 30 seconds to keep the connection alive
 * 3 seconds to acquire a connection
 * 1000 uses to recycle the connection
 */
export const POOL_DEFAULTS = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
  maxUses: 1000,
};

/**
 * Default Postgres `statement_timeout` set on every pooled connection.
 * Caps runaway queries server-side; pairs with the AppKit timeout interceptor.
 */
export const STATEMENT_TIMEOUT_DEFAULT_MS = 15_000;

/**
 * Postgres `application_name` advertised on every connection. Surfaces in
 * `pg_stat_activity` and Lakebase audit so an operator can attribute
 * connections back to AppKit.
 */
export const APPLICATION_NAME = "appkit:database";

/**
 * Per-user (OBO) pool defaults. The plugin builds one pool per OBO user, so
 * each pool stays small. Fan-out is `(1 + oboPoolMax) × max`; with the
 * defaults that caps at `(1 + 25) × 4 + 10 = 114` connections per instance.
 */
export const OBO_POOL_DEFAULTS = {
  ...POOL_DEFAULTS,
  max: 4,
};

export const readDefaults: PluginExecuteConfig = {
  timeout: 30_000,
  retry: { enabled: false },
  cache: { enabled: false },
  telemetryInterceptor: { spanName: "database.read" },
};

export const writeDefaults: PluginExecuteConfig = {
  timeout: 30_000,
  retry: { enabled: false },
  cache: { enabled: false },
  telemetryInterceptor: { spanName: "database.write" },
};
