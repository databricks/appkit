import type { PluginManifest } from "shared";
import { describe, expect, test } from "vitest";

import { CacheManager } from "../../cache";
import { InMemoryStorage } from "../../cache/storage";
import { PluginContext } from "../../core/plugin-context";
import { InitializationError } from "../../errors";
import { mockServiceContext } from "../../testing";
import { Plugin } from "../plugin";

/**
 * How a plugin gets its cache, and how it fails when it has none.
 *
 * This file never boots an app, so an unattached plugin here is genuinely
 * cache-less — there is no process-wide cache to fall back to.
 */

class ProbePlugin extends Plugin {
  static manifest = {
    name: "probe",
    displayName: "Probe",
    version: "0.0.0",
    description: "Reports how its cache was bound",
    resources: { required: [], optional: [] },
  } as unknown as PluginManifest<"probe">;

  /** `cache` is protected, so the read has to happen in-class. */
  boundCache(): CacheManager {
    return this.cache;
  }

  ready(): boolean {
    return this.isReady;
  }

  telemetryProvider(): unknown {
    return this.telemetry;
  }

  /** Drives the interceptor chain the way a handler would. */
  runCached(): Promise<unknown> {
    return this.execute(async () => "value", {
      default: { cache: { enabled: true, cacheKey: ["probe"], ttl: 60 } },
    });
  }

  runUncached(): Promise<unknown> {
    return this.execute(async () => "value", {
      default: { cache: { enabled: false } },
    });
  }
}

function contextWithCache() {
  const cache = CacheManager.forStorage(new InMemoryStorage({} as never));
  return { cache, context: new PluginContext({ cache }) };
}

describe("Plugin cache binding", () => {
  test("an app-less plugin constructs and still has telemetry", () => {
    const plugin = new ProbePlugin({});

    // Telemetry used to be bound only after the cache lookup succeeded, so a
    // plugin built before any app had neither — and failed inside the telemetry
    // interceptor, far from the cause.
    expect(plugin.telemetryProvider()).toBeDefined();
  });

  test("an app-less plugin is not ready until it is attached", () => {
    const plugin = new ProbePlugin({});
    expect(plugin.ready()).toBe(false);

    plugin.attachContext({ context: contextWithCache().context });
    expect(plugin.ready()).toBe(true);
  });

  test("attachContext binds the cache the context carries", () => {
    const { cache, context } = contextWithCache();
    const plugin = new ProbePlugin({});

    plugin.attachContext({ context });

    expect(plugin.boundCache()).toBe(cache);
  });

  test("two plugins attached to one context share its cache", () => {
    const { cache, context } = contextWithCache();
    const first = new ProbePlugin({});
    const second = new ProbePlugin({});

    first.attachContext({ context });
    second.attachContext({ context });

    expect(first.boundCache()).toBe(cache);
    expect(second.boundCache()).toBe(first.boundCache());
  });

  test("a context-less attachContext is the app-less path, not an error", () => {
    const plugin = new ProbePlugin({});

    // `runAgent` runs the lifecycle this way for standalone plugins
    // (core/agent/run-agent.ts). It must bind telemetry and leave the cache
    // unbound rather than refuse: only a cached execution then fails, at the
    // chokepoint the test below covers.
    expect(() => plugin.attachContext({})).not.toThrow();
    expect(() => plugin.attachContext({ context: undefined })).not.toThrow();
  });

  test("a context carrying no cache is not a silent pass", () => {
    const plugin = new ProbePlugin({});

    expect(() =>
      plugin.attachContext({ context: new PluginContext() }),
    ).toThrow(InitializationError);
  });

  test("an unattached plugin's cached execution fails at the chokepoint", async () => {
    const serviceContext = mockServiceContext();
    try {
      const plugin = new ProbePlugin({});

      // Every cached execution passes through `_buildInterceptors`; `cache`'s
      // declared type is non-optional, so the compiler cannot catch this. The
      // old symptom was a TypeError on `undefined.getOrExecute`, inside a
      // request handler.
      const result = await plugin.runCached();

      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).toContain("attachContext");
    } finally {
      serviceContext.restore();
    }
  });

  test("an unattached plugin's direct this.cache read throws, not returns undefined", () => {
    const plugin = new ProbePlugin({});

    // `analytics.ts` and `files/plugin.ts` read `this.cache` directly, outside
    // `execute()`, so the chokepoint above never sees them. The accessor is
    // their guard: a named error at the read, not `undefined` that becomes a
    // `TypeError` two calls later.
    expect(() => plugin.boundCache()).toThrow(InitializationError);
  });

  test("an unattached plugin still runs an uncached execution", async () => {
    const serviceContext = mockServiceContext();
    try {
      const plugin = new ProbePlugin({});

      // The guard fires only when a cached path is actually requested.
      await expect(plugin.runUncached()).resolves.toMatchObject({ ok: true });
    } finally {
      serviceContext.restore();
    }
  });

  test("a plugin cannot substitute its own cache", () => {
    class OwnCachePlugin extends ProbePlugin {
      constructor() {
        super({});
        // @ts-expect-error `cache` is a read-only accessor: every plugin in an
        // app shares the one manager the app built. Use a per-plugin
        // `cache: { enabled, ttl }` config instead.
        this.cache = CacheManager.forStorage(new InMemoryStorage({} as never));
      }
    }

    // Enforced twice over: the `@ts-expect-error` above proves the compiler
    // rejects it, and an accessor with no setter also throws at runtime — so
    // even a JavaScript consumer cannot swap an app's cache.
    expect(() => new OwnCachePlugin()).toThrow(TypeError);
  });
});
