import type { Pool } from "pg";

/**
 * Direct connections available on the smallest Lakebase compute (0.5 CU).
 * Larger computes allow more, so a pool this size fits any configuration.
 *
 * @see https://docs.databricks.com/aws/en/oltp/projects/manage-computes
 */
export const LAKEBASE_MIN_CONNECTION_LIMIT = 105;

/** Default `max` for plugin-owned pools: the most any Lakebase compute allows. */
export const DEFAULT_POOL_MAX = LAKEBASE_MIN_CONNECTION_LIMIT;

/** Minimum gap between saturation warnings for one pool. */
const WARN_INTERVAL_MS = 60_000;

interface SaturationLogger {
  warn(message: string, ...args: unknown[]): void;
}

/**
 * Warn when callers queue for a connection because every pooled client is
 * checked out. Warnings are throttled per pool so a sustained burst logs once
 * a minute instead of once per query.
 *
 * `acquire` fires each time a client is handed out. `waitingCount` is read
 * after the next waiter is dequeued, so a non-zero value means other callers
 * are still waiting behind it.
 */
export function watchPoolSaturation(
  pool: Pool,
  options: { name: string; max: number; logger: SaturationLogger },
): void {
  let lastWarnedAt = Number.NEGATIVE_INFINITY;
  pool.on("acquire", () => {
    if (pool.waitingCount === 0) return;
    const now = Date.now();
    if (now - lastWarnedAt < WARN_INTERVAL_MS) return;
    lastWarnedAt = now;
    options.logger.warn(
      "Lakebase %s pool is saturated: %d of %d connections in use, %d callers waiting. Raise `pool.max` if the Lakebase compute allows more connections.",
      options.name,
      pool.totalCount - pool.idleCount,
      options.max,
      pool.waitingCount,
    );
  });
}
