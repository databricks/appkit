import {
  claimCoreSingletons,
  dropCoreSingletons,
  releaseCoreSingletons,
} from "../core/reset-singletons";

/**
 * Drop the process-wide singletons `createApp()` initializes, ignoring how many
 * apps are live.
 *
 * Pointer drops, not teardown — always close first, or the old app's pools and
 * exporters leak. `app.close()` already handles both, so this is only for tests
 * that hand-roll `createApp`. Prefer {@link claimAppKitSingletons} /
 * {@link releaseAppKitSingletons} when apps can overlap.
 */
export function resetAppKitSingletons(): void {
  dropCoreSingletons();
}

/**
 * Claim the singletons for a booting app; resets only if it is the first.
 *
 * @internal
 */
export function claimAppKitSingletons(): void {
  claimCoreSingletons();
}

/**
 * Release one claim, dropping the singletons once no app holds them.
 *
 * @internal
 */
export function releaseAppKitSingletons(): void {
  releaseCoreSingletons();
}
