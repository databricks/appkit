import { CacheManager } from "../cache";
import { ServiceContext } from "../context";
import { TelemetryReporter } from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";

const logger = createLogger("lifecycle");

/**
 * Drop the four singletons `AppKit._createApp` initializes.
 *
 * Pointer drops, not teardown — callers close first, or the old app's storage and
 * exporters leak. Core initializes all four, so core drops all four; a host that
 * closes then calls `ServiceContext.get()` will get an `InitializationError`.
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
