import type { CacheManager } from "../cache";

/**
 * The caches this kit built for the current test file. Module-level on purpose:
 * Vitest isolates test files in separate workers, so this set is per-file and
 * never leaks across them. A set, not a single slot, because one file can hold
 * several contexts and `resetTestCache()` with no argument clears them all.
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
