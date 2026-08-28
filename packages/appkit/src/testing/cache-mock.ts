import { vi } from "vitest";

/**
 * Build a passthrough fake of the AppKit cache instance for suites that mock
 * the internal `cache` module only to keep `CacheManager.getInstanceSync()`
 * from throwing when no app is booted — its `getOrExecute` runs the work
 * without caching.
 *
 * Internal to the kit, not part of the published surface: it pairs with a
 * `vi.mock("../../../cache", …)` prelude that reaches an internal module path a
 * customer cannot name. Suites that assert real cache *behaviour* should use
 * the published {@link useTestCache} instead.
 *
 * Imports nothing from `../cache`, so it stays safe to `require` inside a
 * `vi.hoisted` block (whose callback runs before the file's imports resolve).
 *
 * @example
 * ```ts
 * const { mockCacheInstance } = vi.hoisted(() => ({
 *   mockCacheInstance: require("../../../testing/cache-mock").createCacheMock(),
 * }));
 * vi.mock("../../../cache", () => ({
 *   CacheManager: {
 *     getInstanceSync: vi.fn(() => mockCacheInstance),
 *     getInstance: vi.fn(async () => mockCacheInstance),
 *   },
 * }));
 * ```
 */
export function createCacheMock() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(
      async (
        _key: unknown[],
        fn: (signal?: AbortSignal) => Promise<unknown>,
        _userKey?: string,
      ) => fn(),
    ),
    generateKey: vi.fn(),
  };
}
