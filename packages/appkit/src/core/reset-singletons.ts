import { CacheManager } from "../cache";
import { ServiceContext } from "../context";
import { TelemetryReporter } from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";

const logger = createLogger("lifecycle");

/**
 * Drop the four process-wide singletons `AppKit._createApp` initializes, so a
 * later `createApp()` builds fresh ones.
 *
 * These are **pointer drops, not teardown**. Callers close first, then reset —
 * resetting a live app leaks whatever its cache storage and exporters hold. The
 * two callers both honour that: `LifecycleManager.close()` runs the shutdown
 * phases first, and the published `resetAppKitSingletons()` documents the order.
 *
 * Symmetry is the justification for the set: core initialized all four in
 * `_createApp`, so core drops all four. This is a semantic expansion rather than
 * purely a bug fix — a host that closes and then expects `ServiceContext.get()`
 * to work will now get an `InitializationError`.
 *
 * Each reset is isolated so one failure cannot skip the others.
 *
 * @internal
 */
export function resetCoreSingletons(): void {
  const resets: [string, () => void][] = [
    ["ServiceContext", () => ServiceContext.reset()],
    ["CacheManager", () => CacheManager.reset()],
    ["TelemetryReporter", () => TelemetryReporter._reset()],
    ["TelemetryManager", () => TelemetryManager.reset()],
  ];

  for (const [name, reset] of resets) {
    try {
      reset();
    } catch (err) {
      logger.error("Error resetting %s: %O", name, err);
    }
  }
}
