import type { CacheManager } from "../cache";

/**
 * The caches this kit built for the current test file.
 *
 * Module-level, and that is the whole point: Vitest isolates test files in
 * separate workers, so this list is per-file by construction and never leaks
 * across them. It lives here rather than on `CacheManager` because it is
 * test-only bookkeeping — the production cache belongs to an app, not to a
 * process-wide registry.
 *
 * A list rather than a single most-recent slot: one file can hold several test
 * contexts, and `resetTestCache()` with no argument is documented to work
 * mid-test, where "the most recent one" would clear the wrong cache.
 *
 * @internal
 */
const kitCaches = new Set<CacheManager>();

/** Record a cache the kit created, so `resetTestCache()` can find it. @internal */
export function registerKitCache(cache: CacheManager): void {
  kitCaches.add(cache);
}

/** Every cache the kit created in this file. @internal */
export function trackedKitCaches(): readonly CacheManager[] {
  return [...kitCaches];
}
