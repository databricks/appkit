import type { PluginExecuteConfig } from "shared";

/**
 * Execution defaults for read-tier operations (list, find, count).
 * Cache 0s (ttl in seconds)
 * Retry 3x with 200ms backoff
 * Timeout 15s
 */
export const readDefaults: PluginExecuteConfig = {
  cache: { enabled: false, ttl: 0 },
  retry: { enabled: true, initialDelay: 200, attempts: 3 },
  timeout: 15_000,
};

/**
 * Execution defaults for write-tier operations (create, update, delete).
 * No cache
 * No retry
 * Timeout 15s
 */
export const writeDefaults: PluginExecuteConfig = {
  cache: { enabled: false, ttl: 0 },
  retry: { enabled: false, initialDelay: 0, attempts: 1 },
  timeout: 15_000,
};

/**
 * Connection pool defaults for the service-principal pool.
 * Max 10 connections
 * Idle timeout 30s
 * Connection timeout 10s
 */
export const POOL_DEFAULTS = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
};

/**
 * Default Postgres `statement_timeout` set on every pooled connection. Caps
 * runaway queries server-side; pairs with the AppKit timeout interceptor.
 */
export const STATEMENT_TIMEOUT_DEFAULT_MS = 15_000;
