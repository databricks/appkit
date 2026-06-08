const WAREHOUSE_POLL_INITIAL_MS = 1_000;
const WAREHOUSE_POLL_MAX_MS = 30_000;

/**
 * Stateful exponential backoff for the warehouse readiness poll loop. Each
 * `next()` returns the next sleep duration with ±15% jitter applied, then
 * doubles the underlying interval up to {@link WAREHOUSE_POLL_MAX_MS}.
 *
 * Jitter spreads retries across concurrent waiters; the cap (30s) prevents
 * pathological starvation when a warehouse takes minutes to come up.
 */
export class WarehousePollBackoff {
  private intervalMs = WAREHOUSE_POLL_INITIAL_MS;

  /** Returns the next sleep duration in ms; advances internal state. */
  next(): number {
    const sleep = this.intervalMs * (0.85 + Math.random() * 0.3);
    this.intervalMs = Math.min(WAREHOUSE_POLL_MAX_MS, this.intervalMs * 2);
    return sleep;
  }
}
