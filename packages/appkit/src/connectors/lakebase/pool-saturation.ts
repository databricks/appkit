import type { Pool } from "pg";

/**
 * Default `max` for plugin-owned pools: the direct connections available on a
 * 0.5 CU Lakebase compute, the smallest size. Every pool, replica, and other
 * client on that compute shares this one budget.
 *
 * @see https://docs.databricks.com/aws/en/oltp/projects/manage-computes
 */
export const DEFAULT_POOL_MAX = 105;

/** Hint for pools whose `max` the app can configure. */
export const RAISE_POOL_MAX_HINT =
  "Raise `pool.max` if the Lakebase compute allows more connections.";

/** Minimum gap between saturation warnings for one pool source. */
const WARN_INTERVAL_MS = 60_000;

interface SaturationLogger {
  warn(message: string, ...args: unknown[]): void;
}

/** One owner of pools, such as the SP pool or the per-user OBO pools. */
interface PoolSaturationSource {
  /** Literal name for the log line. */
  name: "SP" | "OBO" | "database";
  max: number;
  /** Sentence appended to the warning that tells the operator what to do. */
  hint: string;
  logger: SaturationLogger;
}

/**
 * Build the saturation watch for one pool source. Every pool of the source
 * shares one warning throttle, and watching a pool twice is a no-op.
 *
 * The watch wraps `pool.connect`, which `pool.query` also goes through.
 * pg-pool queues a caller inside `connect` before it emits any event, so the
 * counters are read right after the original call. Queued callers are served
 * by idle clients first and then by new clients up to `max`, so the pool is
 * saturated when more callers wait than that capacity can serve without a
 * release.
 */
export function createPoolSaturationWatch(
  source: PoolSaturationSource,
): (pool: Pool) => void {
  let lastWarnedAt = Number.NEGATIVE_INFINITY;
  const watched = new WeakSet<Pool>();

  const warnIfSaturated = (pool: Pool) => {
    if (pool.ending) return;
    const capacity = pool.idleCount + Math.max(0, source.max - pool.totalCount);
    if (pool.waitingCount <= capacity) return;
    const now = Date.now();
    if (now - lastWarnedAt < WARN_INTERVAL_MS) return;
    lastWarnedAt = now;
    source.logger.warn(
      "Lakebase %s pool is saturated: all %d connections are in use and %d callers are waiting. %s",
      source.name,
      source.max,
      pool.waitingCount - capacity,
      source.hint,
    );
  };

  return (pool) => {
    if (watched.has(pool)) return;
    watched.add(pool);
    // pg.Pool.connect has callback and promise overloads, so the wrapper is
    // loosely typed and cast back, as in @databricks/lakebase's query wrapper.
    const origConnect = pool.connect.bind(pool) as (
      ...args: unknown[]
    ) => unknown;
    pool.connect = function connectWithSaturationWatch(...args: unknown[]) {
      const result = origConnect(...args);
      warnIfSaturated(pool);
      return result;
    } as Pool["connect"];
  };
}
