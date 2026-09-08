import { afterEach, beforeEach } from "vitest";

import { CacheManager } from "../cache";
import { InMemoryStorage } from "../cache/storage";
import { resetTestCache } from "./fixtures";

/**
 * The handle {@link useTestCache} returns: a live accessor for the real,
 * in-memory {@link CacheManager} active in the current test.
 */
export interface TestCacheHandle {
  /**
   * The real (in-memory) cache for the current test. Each test's `beforeEach`
   * seeds and clears the singleton, so reading this always sees a fresh cache —
   * call `generateKey`, `get`, `has`, or `vi.spyOn(handle.current, "getOrExecute")`
   * to assert real caching behaviour.
   */
  readonly current: CacheManager;
}

/**
 * Stand up AppKit's real in-memory cache for a test file and clear it before
 * each test, so a plugin's real caching path runs under test with no mock of
 * the internal `cache` module.
 *
 * Boots the process-wide {@link CacheManager} singleton backed by
 * {@link InMemoryStorage} (idempotent — an already-initialized singleton is
 * reused and the storage argument ignored), then clears it via
 * {@link resetTestCache} in `beforeEach` so each test starts empty. The
 * singleton is left in place: this clears the cache's contents, never the
 * pointer.
 *
 * Because the cache is booted before the test body runs, a plugin constructed
 * in the test — whose constructor reads `CacheManager.getInstanceSync()` —
 * binds `this.cache` to this real cache. So `getOrExecute` genuinely caches and
 * the key is production's real `generateKey`, not a re-implemented fake.
 *
 * Call it at the top of a `describe` block (or module top-level), NOT inside a
 * test: Vitest's `beforeEach`/`afterEach` only register during collection.
 *
 * @example
 * ```ts
 * describe("my plugin caches", () => {
 *   const testCache = useTestCache();
 *
 *   test("second identical request is a cache hit", async () => {
 *     const plugin = new MyPlugin(config);
 *     // ...drive the same request twice...
 *     expect(downstreamMock).toHaveBeenCalledTimes(1);
 *   });
 *
 *   test("metadata does not change the cache key", () => {
 *     const key = testCache.current.generateKey(["query", "SELECT 1"], "svc");
 *     expect(key).toBe(testCache.current.generateKey(["query", "SELECT 1"], "svc"));
 *   });
 * });
 * ```
 *
 * @returns `{ current }` — the active real {@link CacheManager} for the test.
 */
export function useTestCache(): TestCacheHandle {
  let cache: CacheManager | undefined;

  beforeEach(async () => {
    // Idempotent: reuses an existing singleton (ignoring the storage arg) or
    // stands up a fresh in-memory one. Keeps the singleton either way.
    cache = await CacheManager.getInstance({
      storage: new InMemoryStorage({}),
    });
    // Fresh contents per test — clears storage without dropping the singleton.
    await resetTestCache();
  });

  afterEach(() => {
    cache = undefined;
  });

  return {
    get current(): CacheManager {
      if (!cache) {
        throw new Error(
          "useTestCache: no active cache. Call useTestCache() at the top of a " +
            "describe block (not inside a test), and read `.current` from " +
            "within a test.",
        );
      }
      return cache;
    },
  };
}
