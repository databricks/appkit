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
