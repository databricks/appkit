import { CacheManager } from "../cache";
import { ServiceContext } from "../context";
import { TelemetryReporter } from "../internal-telemetry";
import { createLogger } from "../logging/logger";
import { TelemetryManager } from "../telemetry";

const logger = createLogger("lifecycle");

/**
 * How many apps currently own the core singletons.
 *
 * They are process-wide, so a per-app "reset on boot, reset on close" model
 * cross-wires overlapping apps: booting B rebinds A's `ServiceContext` and
 * `CacheManager` to B's, and closing A while B is live leaves B with none at all
 * (`ServiceContext.get()` throws `InitializationError`). Refcounting means the
 * first boot claims them and only the last close drops them — the same model the
 * harness already uses for its `process.env` baseline.
 */
let owners = 0;

/**
 * Claim the singletons for a booting app, resetting only when it is the first.
 *
 * The reset is what clears leakage from a previous test; a *second* concurrent
 * app must not repeat it.
 *
 * @internal
 */
export function claimCoreSingletons(): void {
  if (owners === 0) dropCoreSingletons();
  owners += 1;
}

/**
 * Release one app's claim, dropping the singletons once none are left.
 *
 * @internal
 */
export function releaseCoreSingletons(): void {
  owners = Math.max(0, owners - 1);
  if (owners === 0) dropCoreSingletons();
}

/**
 * Drop the four singletons `AppKit._createApp` initializes, ignoring refcounts.
 *
 * Pointer drops, not teardown — callers close first, or the old app's storage and
 * exporters leak. Core initializes all four, so core drops all four; a host that
 * closes then calls `ServiceContext.get()` will get an `InitializationError`.
 *
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
