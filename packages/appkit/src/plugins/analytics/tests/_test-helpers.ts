import { createTestPluginContext } from "../../../testing";
import { AnalyticsPlugin } from "../analytics";
import type { IAnalyticsConfig } from "../types";

/**
 * One kit context for the analytics suites — Vitest isolates files, so this
 * module is re-evaluated per file and the `kit` stays per-file. It supplies the
 * real `CacheManager`, whose `generateKey` is production's, so key invariants
 * are asserted against the real thing rather than a copy that can drift.
 */
const kit = createTestPluginContext();

/**
 * The cache every plugin from {@link analyticsPlugin} resolves as `this.cache`.
 * Spy it (`vi.spyOn(testCache, "getOrExecute")`) to assert caching against
 * production's own keying.
 */
export const testCache = kit.cache;

/** Build an `AnalyticsPlugin` bound to this file's cache, the way an app does. */
export function analyticsPlugin(config: IAnalyticsConfig): AnalyticsPlugin {
  return kit.attach(new AnalyticsPlugin(config));
}
