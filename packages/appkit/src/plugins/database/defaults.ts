import type { PluginExecuteConfig } from "shared";

/** SP pool defaults — max 10, 30s idle, 3s acquire, 1000 uses per conn. */
export const POOL_DEFAULTS = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
  maxUses: 1000,
};

/** Server-side `statement_timeout` per pooled connection. Pairs with the AppKit timeout interceptor. */
export const STATEMENT_TIMEOUT_DEFAULT_MS = 15_000;

/** `application_name` per connection — surfaces in `pg_stat_activity`/Lakebase audit. */
export const APPLICATION_NAME = "appkit:database";

/**
 * OBO pool defaults — small (one pool per user). Fan-out = `(1 + oboPoolMax) × max`;
 * defaults cap at `(1+25)×4 + 10 ≈ 114` conns per instance.
 */
export const OBO_POOL_DEFAULTS = {
  ...POOL_DEFAULTS,
  max: 4,
};

/** Default page size when no `?limit=` is given. */
export const DEFAULT_LIMIT = 50;
/** Hard cap; opt out via `.unbounded()` for background jobs. */
export const MAX_LIMIT = 500;

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
