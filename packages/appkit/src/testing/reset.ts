import { dropCoreSingletons } from "../core/reset-singletons";

/**
 * Drop the process-wide singletons `createApp()` initializes.
 *
 * A pointer drop, not teardown — close first or the old app's pools and
 * exporters leak. `app.close()` does both, so this is only for tests that
 * hand-roll `createApp`.
 */
export function resetGlobalState(): void {
  dropCoreSingletons();
}
