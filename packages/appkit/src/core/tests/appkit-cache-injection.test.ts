import type { PluginManifest } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CacheManager } from "../../cache";
import { InMemoryStorage } from "../../cache/storage";
import { Plugin, toPlugin } from "../../plugin";
import { mockServiceContext, setupDatabricksEnv } from "../../testing";
import { PluginContext } from "../plugin-context";

// Each app owns one real `CacheManager`, reached through its own
// `PluginContext` — the cache module is not mocked (a fake would assert
// nothing here). Every boot passes `cache: { storage }`, without which
// `create()` probes Lakebase.

/** Instances registered by `setup()`, so tests can read a real plugin's cache. */
const constructed: CacheProbe[] = [];

/** Shared probe behaviour. Each concrete plugin declares its own manifest — a
 * subclass cannot narrow the static side, so they are siblings, not a chain. */
abstract class CacheProbe extends Plugin {
  override async setup() {
    constructed.push(this);
  }

  /** `cache` is protected, so the read has to happen in-class. */
  boundCache(): CacheManager {
    return this.cache;
  }

  /** Proves the manager never reaches plugin config — see the KTD4 gate test. */
  configCache(): unknown {
    return (this.config as Record<string, unknown>).cache;
  }
}

class ProbePlugin extends CacheProbe {
  static manifest = {
    name: "probe",
    displayName: "Probe",
    version: "0.0.0",
    description: "Reports the cache it was bound to",
    resources: { required: [], optional: [] },
  } as unknown as PluginManifest<"probe">;
}

class ProbeTwoPlugin extends CacheProbe {
  static manifest = {
    name: "probeTwo",
    displayName: "Probe Two",
    version: "0.0.0",
    description: "A second cache-using plugin in the same app",
    resources: { required: [], optional: [] },
  } as unknown as PluginManifest<"probeTwo">;
}

const probe = toPlugin(ProbePlugin);
const probeTwo = toPlugin(ProbeTwoPlugin);

/** Managers `create()` built, in boot order — captured by spying on `create`
 * so a test can assert each app resolved its own. */
const built: CacheManager[] = [];
const realCreate = CacheManager.create.bind(CacheManager);

/** Read a manager's private field without adding a public accessor. */
function privateField<T>(manager: CacheManager, key: string): T {
  return (manager as unknown as Record<string, T>)[key];
}

describe("per-app CacheManager injection", () => {
  let serviceContextMock: ReturnType<typeof mockServiceContext>;

  beforeEach(() => {
    constructed.length = 0;
    built.length = 0;
    setupDatabricksEnv();
    serviceContextMock = mockServiceContext();
    vi.spyOn(CacheManager, "create").mockImplementation(async (userConfig) => {
      const manager = await realCreate(userConfig);
      vi.spyOn(manager, "close");
      built.push(manager);
      return manager;
    });
  });

  afterEach(() => {
    serviceContextMock.restore();
    vi.restoreAllMocks();
  });

  /** Boot one app offline and return it with the manager it built. */
  async function bootApp(
    plugins: unknown[],
    cache: Record<string, unknown> = {},
  ) {
    const { createApp } = await import("../appkit");
    const handle = await createApp({
      plugins,
      cache: { storage: new InMemoryStorage(), ...cache },
    } as never);
    return { handle, manager: built[built.length - 1] };
  }

  test("two apps in one process hold different managers", async () => {
    const first = await bootApp([probe({})]);
    const second = await bootApp([probe({})]);

    expect(second.manager).not.toBe(first.manager);
  });

  test("the second app's cache config is honoured, not discarded", async () => {
    const first = await bootApp([probe({})], { ttl: 60 });
    const second = await bootApp([probe({})], { ttl: 3600 });

    // A shared manager would make B silently inherit A's ttl; each keeps its own.
    expect(privateField<{ ttl?: number }>(first.manager, "config").ttl).toBe(
      60,
    );
    expect(privateField<{ ttl?: number }>(second.manager, "config").ttl).toBe(
      3600,
    );
  });

  test("the app's manager uses the storage the caller supplied", async () => {
    const storage = new InMemoryStorage();
    const { manager } = await bootApp([probe({})], { storage });

    expect(privateField(manager, "storage")).toBe(storage);
  });

  test("every plugin in one app resolves that app's own manager", async () => {
    // Booted second on purpose: a plugin that resolved its cache from anywhere
    // but its own context would get the *first* app's cache, and this assertion
    // would fail.
    await bootApp([probe({})]);
    const { manager } = await bootApp([probe({}), probeTwo({})]);

    const second = constructed.slice(-2);
    expect(second).toHaveLength(2);
    for (const plugin of second) {
      expect(plugin.boundCache()).toBe(manager);
    }
  });

  test("the manager never reaches plugin config", async () => {
    await bootApp([probe({})]);

    // A CacheManager here would be deep-merged into execute options, where
    // `PluginExecuteConfig.cache` is declared a `CacheConfig` — silently
    // breaking the cache interceptor's gate.
    expect(constructed[0].configCache()).not.toBeInstanceOf(CacheManager);
  });

  test("PluginContext exposes the cache it was given, and it cannot be swapped", () => {
    const cache = CacheManager.forStorage(new InMemoryStorage());
    const context = new PluginContext({ cache });

    expect(context.cache).toBe(cache);
    // @ts-expect-error `cache` is readonly: an app's cache cannot be replaced.
    context.cache = CacheManager.forStorage(new InMemoryStorage());
  });

  test("a consumer has no way to construct a manager", () => {
    // @ts-expect-error the constructor is private — `create` and `forStorage`
    // are the only entries, which is what makes one-manager-per-app checkable.
    void new CacheManager(new InMemoryStorage(), {} as never);
  });
});

describe("a failed boot closes the manager it built", () => {
  let serviceContextMock: ReturnType<typeof mockServiceContext>;

  beforeEach(() => {
    built.length = 0;
    constructed.length = 0;
    setupDatabricksEnv();
    serviceContextMock = mockServiceContext();
    vi.spyOn(CacheManager, "create").mockImplementation(async (userConfig) => {
      const manager = await realCreate(userConfig);
      vi.spyOn(manager, "close");
      built.push(manager);
      return manager;
    });
  });

  afterEach(() => {
    serviceContextMock.restore();
    vi.restoreAllMocks();
  });

  async function failedBoot(config: Record<string, unknown>) {
    const { createApp } = await import("../appkit");
    await expect(
      createApp({
        cache: { storage: new InMemoryStorage() },
        ...config,
      } as never),
    ).rejects.toThrow();
  }

  /**
   * Nothing else holds a reference once the boot unwinds, so an unclosed manager
   * is unreachable — and one that resolved to Lakebase owns a `pg.Pool` that
   * would never be ended.
   */
  test("when onPluginsReady throws", async () => {
    await failedBoot({
      plugins: [probe({})],
      onPluginsReady: () => {
        throw new Error("boom");
      },
    });

    expect(built).toHaveLength(1);
    expect(built[0].close).toHaveBeenCalledTimes(1);
  });

  test("when a plugin's setup() rejects", async () => {
    class FailingSetupPlugin extends CacheProbe {
      static manifest = {
        name: "failingSetup",
        displayName: "Failing Setup",
        version: "0.0.0",
        description: "Rejects during setup",
        resources: { required: [], optional: [] },
      } as unknown as PluginManifest<"failingSetup">;

      override async setup() {
        throw new Error("setup failed");
      }
    }

    await failedBoot({ plugins: [toPlugin(FailingSetupPlugin)({})] });

    expect(built[0].close).toHaveBeenCalledTimes(1);
  });

  test("when attaching a plugin throws inside the AppKit constructor", async () => {
    // The site `attachContext`'s own cache guard creates.
    const attach = vi
      .spyOn(Plugin.prototype, "attachContext")
      .mockImplementation(() => {
        throw new Error("attach failed");
      });
    try {
      await failedBoot({ plugins: [probe({})] });
      expect(built[0].close).toHaveBeenCalledTimes(1);
    } finally {
      attach.mockRestore();
    }
  });

  test("a boot that fails before the manager exists attempts no close", async () => {
    vi.spyOn(CacheManager, "create").mockRejectedValueOnce(
      new Error("cache construction failed"),
    );

    await failedBoot({ plugins: [probe({})] });

    expect(built).toHaveLength(0);
  });

  test("the boot error is not masked by a failing close", async () => {
    vi.spyOn(CacheManager, "create").mockImplementationOnce(async (cfg) => {
      const manager = await realCreate(cfg);
      vi.spyOn(manager, "close").mockRejectedValue(new Error("close failed"));
      built.push(manager);
      return manager;
    });

    const { createApp } = await import("../appkit");
    await expect(
      createApp({
        plugins: [probe({})],
        cache: { storage: new InMemoryStorage() },
        onPluginsReady: () => {
          throw new Error("the real cause");
        },
      } as never),
    ).rejects.toThrow("the real cause");
  });
});
