import { CacheManager } from "../cache";
import { ServiceContext } from "../context";
import { TelemetryReporter } from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";

const logger = createLogger("lifecycle");

/**
 * Drop the process-wide singletons `AppKit._createApp` initializes — called on
 * boot to clear a previous test's leakage, and on close.
 *
 * A pointer drop, not teardown — close first or the old app's storage and
 * exporters leak. A host that closes then calls `ServiceContext.get()` gets an
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
