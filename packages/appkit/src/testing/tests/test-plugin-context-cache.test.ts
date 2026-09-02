import type { PluginManifest } from "shared";
import { describe, expect, test, vi } from "vitest";

import { CacheManager } from "../../cache";
import { Plugin } from "../../plugin";
import { mockServiceContext } from "../fixtures";
import { createTestPluginContext } from "../test-plugin-context";

/**
 * The cache a `createTestPluginContext` carries, and the plugin that resolves it.
 *
 * The identity assertions here are the load-bearing ones: if the handle's cache
 * were not the object the plugin uses, every spy in every suite would record
 * nothing and the tests would still pass.
 */

class CachingPlugin extends Plugin {
  static manifest = {
    name: "caching",
    displayName: "Caching",
    version: "0.0.0",
    description: "Runs a cached execution",
    resources: { required: [], optional: [] },
  } as unknown as PluginManifest<"caching">;

  /** `cache` is protected, so the read has to happen in-class. */
  boundCache(): CacheManager {
    return this.cache;
  }

  /** A cached read, the way a handler would do it. */
  fetch(work: () => Promise<string>): Promise<unknown> {
    return this.execute(work, {
      default: { cache: { enabled: true, cacheKey: ["caching", "fetch"] } },
    });
  }
}

describe("createTestPluginContext's cache", () => {
  test("the handle exposes a real CacheManager", () => {
    const mock = createTestPluginContext();

    expect(mock.cache).toBeInstanceOf(CacheManager);
  });

  test("an attached plugin resolves the handle's cache, not another", async () => {
    const mock = createTestPluginContext();
    const plugin = await mock.attach(new CachingPlugin({}));

    // If these were different objects, a spy on `mock.cache` would silently
    // record nothing while the suite stayed green.
    expect(plugin.boundCache()).toBe(mock.cache);
  });

  test("two contexts in one file get independent caches", async () => {
    const first = createTestPluginContext();
    const second = createTestPluginContext();

    expect(second.cache).not.toBe(first.cache);

    const key = first.cache.generateKey(["probe"], "user");
    await first.cache.set(key, { from: "first" });

    await expect(second.cache.get(key)).resolves.toBeNull();
  });

  test("an attached plugin's cached path really caches", async () => {
    const serviceContext = mockServiceContext();
    try {
      const mock = createTestPluginContext();
      const plugin = await mock.attach(new CachingPlugin({}));
      const work = vi.fn(async () => "value");

      await plugin.fetch(work);
      await plugin.fetch(work);

      // Production's own `getOrExecute`, so a second identical call is a hit.
      expect(work).toHaveBeenCalledTimes(1);
    } finally {
      serviceContext.restore();
    }
  });

  test("a spy on the handle's cache records what the plugin did", async () => {
    const serviceContext = mockServiceContext();
    try {
      const mock = createTestPluginContext();
      const plugin = await mock.attach(new CachingPlugin({}));
      const getOrExecute = vi.spyOn(mock.cache, "getOrExecute");

      await plugin.fetch(async () => "value");

      expect(getOrExecute).toHaveBeenCalledTimes(1);
      // The key parts are the plugin's, hashed by production's `generateKey`.
      expect(getOrExecute.mock.calls[0][0]).toEqual(["caching", "fetch"]);
    } finally {
      serviceContext.restore();
    }
  });

  test("attaching touches no process-wide slot", async () => {
    const publish = vi.spyOn(CacheManager, "_publishAmbient");
    const mock = createTestPluginContext();

    await mock.attach(new CachingPlugin({}));

    expect(publish).not.toHaveBeenCalled();
    publish.mockRestore();
  });

  test("the handle's key function is production's", () => {
    const mock = createTestPluginContext();

    const a = mock.cache.generateKey(["query", "SELECT 1"], "svc");
    const b = mock.cache.generateKey(["query", "SELECT 1"], "svc");
    const perUser = mock.cache.generateKey(["query", "SELECT 1"], "other");

    expect(a).toBe(b);
    expect(perUser).not.toBe(a);
  });
});
