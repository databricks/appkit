import { CacheManager } from "../cache";
import { ServiceContext } from "../context";
import { TelemetryReporter } from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";

const logger = createLogger("lifecycle");

/**
 * How many apps own the core singletons. Refcounted because they are
 * process-wide: resetting per app would have booting B rebind A's
 * `ServiceContext`, and closing A leave a still-live B with none.
 */
let owners = 0;

/**
 * Claim for a booting app, resetting only when it is the first — the reset
 * clears leakage from a previous test, so a concurrent second app must not
 * repeat it.
 * @internal
 */
export function claimCoreSingletons(): void {
  if (owners === 0) dropCoreSingletons();
  owners += 1;
}

/**
 * Release one app's claim, dropping the singletons once none are left.
 * @internal
 */
export function releaseCoreSingletons(): void {
  owners = Math.max(0, owners - 1);
  if (owners === 0) dropCoreSingletons();
}

/**
 * Drop the four singletons `AppKit._createApp` initializes, ignoring refcounts.
 *
 * Pointer drops, not teardown — close first or the old app's storage and
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
