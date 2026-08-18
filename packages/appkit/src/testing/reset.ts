/**
 * Reset the process-wide singletons AppKit's core initializes, so a test file
 * can boot more than one app.
 *
 * @module
 */

import { resetCoreSingletons } from "../core/reset-singletons";

/**
 * Drop the four singletons `createApp()` initializes: the service context, the
 * cache manager, the internal-telemetry reporter, and the telemetry manager.
 *
 * These are **pointer drops, not teardown**. Anything holding I/O — a cache
 * storage pool, a live OTLP exporter — must be released first, which is what
 * `app.close()` does. The safe order is always *close, then reset*; resetting a
 * live app leaks its resources instead of freeing them.
 *
 * `app.close()` already calls this, so a test using `createTestApp` or the app
 * handle never needs it. It exists for a test that hand-rolls `createApp` and
 * would otherwise have to deep-import `../context/service-context` to reach
 * `ServiceContext.reset()` — a path that is not part of the package's public
 * exports.
 *
 * Distinct from `resetTestCache()`, which calls `clear()` on the *existing*
 * cache. That empties entries and keeps the instance; this discards the
 * instance.
 *
 * Each reset is isolated, so one failure cannot skip the others.
 *
 * @example
 * ```ts
 * afterEach(async () => {
 *   await app.close();      // release the sockets, pools, and exporters
 *   resetAppKitSingletons(); // then drop the pointers
 * });
 * ```
 */
export function resetAppKitSingletons(): void {
  resetCoreSingletons();
}
