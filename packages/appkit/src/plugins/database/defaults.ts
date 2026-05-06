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

/** GUC name AppKit `SET`s on every OBO connection for RLS policies to read. */
export const DEFAULT_RLS_SESSION_VARIABLE = "app.user_id";

/**
 * OBO pool defaults. `max=2` because a single user typically serializes HTTP
 * requests; 2 conns covers occasional overlap without bloating fan-out.
 * Combined with `oboPoolMax=100`, fan-out is `(1+100)×2 + 10 ≈ 212` conns.
 */
export const OBO_POOL_DEFAULTS = {
  ...POOL_DEFAULTS,
  max: 2,
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
