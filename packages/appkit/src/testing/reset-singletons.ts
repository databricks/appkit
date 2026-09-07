import { CacheManager } from "../cache";
import { ServiceContext } from "../context";
import { TelemetryReporter } from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";

const logger = createLogger("testing");

/**
 * Drop the process-wide singletons `AppKit._createApp` initializes — called by
 * the harness on boot to clear a previous test's leakage, and on teardown.
 *
 * Kit-owned: the only caller is the test harness, so it lives here rather than
 * in core. A pointer drop, not teardown — close the app first (the harness runs
 * the shutdown phases before this) or the old app's storage and exporters leak.
 * A caller that drops then reads `ServiceContext.get()` gets an
 * `InitializationError`.
 * @internal
 */
export function dropCoreSingletons(): void {
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
