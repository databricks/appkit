import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CacheManager } from "..";
import { InitializationError } from "../../errors";
import { InMemoryStorage } from "../storage/memory";

/**
 * `getInstance()` returns the existing instance, so after `cache.close()` the
 * singleton still points at closed storage — under `PersistentStorage` an ended
 * `pg.Pool`. Every test passes explicit `storage` so nothing probes Lakebase.
 */
describe("CacheManager.reset", () => {
  beforeEach(() => {
    CacheManager.reset();
  });

  afterEach(() => {
    CacheManager.reset();
  });

  function storage() {
    return new InMemoryStorage({ enabled: true, maxSize: 100 } as never);
  }

  test("the next getInstance() builds a fresh instance, not the closed one", async () => {
    const first = await CacheManager.getInstance({ storage: storage() });
    await first.close();

    CacheManager.reset();
    const second = await CacheManager.getInstance({ storage: storage() });

    expect(second).not.toBe(first);

    // The point of the fix: the fresh instance's storage is live, so a
    // write-then-read round-trips instead of hitting closed storage.
    const key = second.generateKey(["reset-probe"], "test-user");
    await second.set(key, { ok: true });
    await expect(second.get(key)).resolves.toEqual({ ok: true });
  });

  test("without a reset, getInstance() keeps returning the same instance", async () => {
    // The regression guard for the *unchanged* path: a single boot with no reset
    // must behave exactly as before.
    const first = await CacheManager.getInstance({ storage: storage() });
    const second = await CacheManager.getInstance({ storage: storage() });

    expect(second).toBe(first);
  });

  test("reset clears an in-flight initPromise, not just the instance", async () => {
    // Start initialization but do not await it, so `instance` is still null and
    // only `initPromise` is set. Clearing just `instance` would leave the next
    // caller awaiting a promise that resolves to the discarded manager —
    // getInstance() returns initPromise when instance is null.
    const pending = CacheManager.getInstance({ storage: storage() });

    CacheManager.reset();

    const first = await pending;
    const second = await CacheManager.getInstance({ storage: storage() });

    expect(second).not.toBe(first);
  });

  test("getInstanceSync throws after a reset", async () => {
    await CacheManager.getInstance({ storage: storage() });
    expect(() => CacheManager.getInstanceSync()).not.toThrow();

    CacheManager.reset();

    // Reset is a pointer drop, so the sync accessor is back to its
    // not-initialized contract rather than handing out a stale manager.
    expect(() => CacheManager.getInstanceSync()).toThrow(InitializationError);
  });

  test("reset is safe when the cache was never initialized", () => {
    expect(() => CacheManager.reset()).not.toThrow();
    expect(() => CacheManager.reset()).not.toThrow();
  });

  test("without a reset, the next boot reuses storage the last teardown closed", async () => {
    // Models PersistentStorage, whose close() is `pool.end()` — permanent.
    // InMemoryStorage.close() merely clears a Map and stays usable, which is why
    // an in-memory test cannot show this and why the bug hid for so long.
    function endableStorage() {
      let ended = false;
      const entries = new Map<string, unknown>();
      const guard = <T>(fn: () => T) => {
        if (ended) throw new Error("Cannot use a pool after calling end()");
        return fn();
      };
      return {
        get: async (k: string) =>
          guard(() => (entries.get(k) ?? null) as never),
        set: async (k: string, v: unknown) =>
          guard(() => void entries.set(k, v)),
        delete: async (k: string) => guard(() => void entries.delete(k)),
        clear: async () => guard(() => entries.clear()),
        has: async (k: string) => guard(() => entries.has(k)),
        size: async () => guard(() => entries.size),
        isPersistent: () => true,
        healthCheck: async () => !ended,
        close: async () => {
          ended = true;
        },
      };
    }

    const first = await CacheManager.getInstance({
      storage: endableStorage() as never,
    });
    await first.close();

    // The bug, with no reset in between: getInstance() hands back the same
    // manager, still pointing at storage that has been ended.
    const stale = await CacheManager.getInstance({
      storage: endableStorage() as never,
    });
    expect(stale).toBe(first);
    await expect(
      stale.set(stale.generateKey(["x"], "test-user"), { v: 1 }),
    ).rejects.toThrow(/after calling end/);

    // The fix: reset drops the pointer, so the next boot builds over live
    // storage and the same write succeeds.
    CacheManager.reset();
    const fresh = await CacheManager.getInstance({
      storage: endableStorage() as never,
    });
    expect(fresh).not.toBe(first);
    const key = fresh.generateKey(["x"], "test-user");
    await fresh.set(key, { v: 1 });
    await expect(fresh.get(key)).resolves.toEqual({ v: 1 });
  });
});
