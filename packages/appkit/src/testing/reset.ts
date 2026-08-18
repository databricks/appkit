import { resetCoreSingletons } from "../core/reset-singletons";

/**
 * Drop the process-wide singletons `createApp()` initializes, so a file can boot
 * more than one app.
 *
 * Pointer drops, not teardown — always close first, or the old app's pools and
 * exporters leak. `app.close()` already does both, so this is only for tests
 * that hand-roll `createApp`.
 */
export function resetAppKitSingletons(): void {
  resetCoreSingletons();
}
