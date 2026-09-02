import type { CacheConfig, CacheStorage } from "shared";
import { describe, expect, test, vi } from "vitest";

import { CacheManager } from "..";
import { InMemoryStorage } from "../storage/memory";

/**
 * Who owns the storage a manager closes.
 *
 * A caller who passes `cache: { storage }` keeps ownership, so `close()` must
 * leave it alone. The hazard has been invisible because `InMemoryStorage.close()`
 * merely clears a `Map` and stays usable, while `PersistentStorage.close()` is
 * `pool.end()` and permanent — and because `getInstance` was first-wins and
 * discarded a second caller's storage, so nothing exercised the borrowed path.
 */

function inMemory(): InMemoryStorage {
  return new InMemoryStorage({ enabled: true, maxSize: 100 } as never);
}

/** Models a storage whose close is permanent, the way `pool.end()` is. */
class EndableStorage extends InMemoryStorage {
  ended = false;

  override async close(): Promise<void> {
    this.ended = true;
  }
}

function endable(): EndableStorage {
  return new EndableStorage({ enabled: true, maxSize: 100 } as never);
}

/** A storage that reports unhealthy, forcing `create()` to build its own. */
function unhealthy(): CacheStorage {
  const storage = inMemory();
  vi.spyOn(storage, "healthCheck").mockResolvedValue(false);
  return storage;
}

const config = (extra: Partial<CacheConfig> = {}) =>
  ({ enabled: true, ...extra }) as Partial<CacheConfig>;

describe("CacheManager storage ownership", () => {
  test("storage the caller supplied survives close and stays usable", async () => {
    const storage = endable();
    const manager = await CacheManager.create(config({ storage }));

    await manager.close();

    expect(storage.ended).toBe(false);
    const key = manager.generateKey(["probe"], "user");
    await manager.set(key, { ok: true });
    await expect(manager.get(key)).resolves.toEqual({ ok: true });
  });

  test("storage the manager built is closed", async () => {
    // No `storage` given and Lakebase unreachable in tests, so `create()` falls
    // back to storage it owns.
    const manager = await CacheManager.create(config());
    const storage = (manager as unknown as { storage: CacheStorage }).storage;
    const close = vi.spyOn(storage, "close");

    await manager.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  test("a supplied storage that fails its health check yields owned storage", async () => {
    // The branch a "was storage supplied?" flag would get wrong: `create()`
    // builds a fresh in-memory storage *inside* the supplied-storage branch, so
    // that replacement is the manager's to close.
    const supplied = unhealthy();
    const manager = await CacheManager.create(config({ storage: supplied }));

    const actual = (manager as unknown as { storage: CacheStorage }).storage;
    expect(actual).not.toBe(supplied);

    const close = vi.spyOn(actual, "close");
    await manager.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("a supplied storage that fails its health check is not closed", async () => {
    const supplied = endable();
    vi.spyOn(supplied, "healthCheck").mockResolvedValue(false);

    const manager = await CacheManager.create(config({ storage: supplied }));
    await manager.close();

    expect(supplied.ended).toBe(false);
  });

  test("forStorage treats the kit's storage as borrowed", async () => {
    const storage = endable();
    const manager = CacheManager.forStorage(storage);

    await manager.close();

    expect(storage.ended).toBe(false);
  });

  test("two managers over one storage: closing the first leaves the second usable", async () => {
    // The shape a test harness reaches by passing the same storage to two boots.
    const storage = inMemory();
    const first = await CacheManager.create(config({ storage }));
    const second = await CacheManager.create(config({ storage }));

    const key = second.generateKey(["shared"], "user");
    await second.set(key, { alive: true });
    await first.close();

    await expect(second.get(key)).resolves.toEqual({ alive: true });
  });
});
