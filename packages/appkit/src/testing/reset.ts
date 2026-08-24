import {
  claimCoreSingletons,
  dropCoreSingletons,
  releaseCoreSingletons,
} from "../core/reset-singletons";

/**
 * Drop the process-wide singletons `createApp()` initializes, ignoring how many
 * apps are live.
 *
 * A pointer drop, not teardown — close first or the old app's pools and
 * exporters leak. `app.close()` does both, so this is only for tests that
 * hand-roll `createApp`.
 */
export function resetGlobalState(): void {
  dropCoreSingletons();
}

/**
 * Claim the singletons for a booting app; resets only if it is the first.
 * @internal
 */
export function claimAppKitSingletons(): void {
  claimCoreSingletons();
}

/**
 * Release one claim, dropping the singletons once no app holds them.
 * @internal
 */
export function releaseAppKitSingletons(): void {
  releaseCoreSingletons();
}
