import {
  getListeningPort,
  mockServiceContext,
  setupDatabricksEnv,
} from "@databricks/appkit/testing";
import type { AppHandle, PluginManifest, PluginMap } from "shared";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CacheManager } from "../../cache";
import { ServiceContext } from "../../context/service-context";
import { ConfigurationError } from "../../errors";
import { Plugin, toPlugin } from "../../plugin";
import { server as serverPlugin } from "../../plugins/server";
import { createApp } from "../appkit";

/**
 * Deliberately unmocked — the claim is that `close()` releases *real* resources,
 * so a mocked lifecycle would assert nothing. `port: 0` keeps it parallel-safe.
 */

/** Minimal plugin with a route, so there is something real to serve. */
class ProbePlugin extends Plugin {
  static manifest: PluginManifest = {
    name: "probe",
    displayName: "Probe",
    version: "0.0.0",
    description: "close() integration probe",
    resources: { required: [] },
  } as unknown as PluginManifest;

  /** Set when the lifecycle actually ran this plugin's teardown. */
  shutdownCalls = 0;

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }

  exports() {
    return { shutdownCalls: () => this.shutdownCalls };
  }
}
const probe = toPlugin(ProbePlugin);

/** A plugin whose manifest name collides with the handle's own method. */
class ClosePlugin extends Plugin {
  static manifest: PluginManifest = {
    name: "close",
    displayName: "Close",
    version: "0.0.0",
    description: "reserved-name probe",
    resources: { required: [] },
  } as unknown as PluginManifest;
}
const closeNamed = toPlugin(ClosePlugin);

describe("app handle close()", () => {
  let serviceContextMock: ReturnType<typeof mockServiceContext>;

  beforeEach(() => {
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  test("releases the bound socket and runs plugin teardown", async () => {
    const termBaseline = process.listenerCount("SIGTERM");

    const app = await createApp({
      plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
    });

    // AppKit installed its handlers, so the count went up.
    expect(process.listenerCount("SIGTERM")).toBe(termBaseline + 1);

    const port = await getListeningPort(app.server.getServer());
    const baseUrl = `http://127.0.0.1:${port}`;
    await expect(
      fetch(`${baseUrl}/health`).then((r) => r.status),
    ).resolves.toBe(200);

    await app.close();

    expect(app.probe.shutdownCalls()).toBe(1);
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
    // Signal handlers came back off — what keeps repeated boots from tripping
    // MaxListenersExceededWarning.
    expect(process.listenerCount("SIGTERM")).toBe(termBaseline);
  });

  test("is idempotent at the app level", async () => {
    const app = await createApp({
      plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
    });
    await getListeningPort(app.server.getServer());

    await app.close();
    await expect(app.close()).resolves.toBeUndefined();

    // The memo means the phases ran once, not twice.
    expect(app.probe.shutdownCalls()).toBe(1);
  });

  test("plugin exports stay reachable by name alongside close()", async () => {
    const app = await createApp({
      plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
    });
    await getListeningPort(app.server.getServer());

    try {
      // Adding `close` to the handle must not shadow or be shadowed by the
      // plugin accessors installed with defineProperty.
      expect(typeof app.close).toBe("function");
      expect(typeof app.server.getServer).toBe("function");
      expect(typeof app.probe.shutdownCalls).toBe("function");
      expect(typeof app[Symbol.asyncDispose]).toBe("function");
    } finally {
      await app.close();
    }
  });

  test("a server-less app still closes cleanly", async () => {
    // No server plugin at all: nothing bound a socket, but plugin hooks and the
    // telemetry flush still have to run, and close() must not hang.
    const app = await createApp({ plugins: [probe()] });

    await expect(app.close()).resolves.toBeUndefined();
    expect(app.probe.shutdownCalls()).toBe(1);
  });

  test("await using releases the app at scope exit", async () => {
    let captured: number | undefined;
    let probeHandle: { shutdownCalls: () => number } | undefined;

    {
      await using app = await createApp({
        plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
      });
      captured = await getListeningPort(app.server.getServer());
      probeHandle = app.probe;
      await expect(
        fetch(`http://127.0.0.1:${captured}/health`).then((r) => r.status),
      ).resolves.toBe(200);
    }

    // Scope exited, so asyncDispose ran the same teardown.
    expect(probeHandle?.shutdownCalls()).toBe(1);
    await expect(
      fetch(`http://127.0.0.1:${captured}/health`),
    ).rejects.toThrow();
  });

  test("a plugin named close is rejected instead of silently shadowing", async () => {
    // An own property wins over a prototype method, so without this guard the
    // plugin would quietly replace teardown rather than fail.
    await expect(createApp({ plugins: [closeNamed()] })).rejects.toThrow(
      ConfigurationError,
    );
    await expect(createApp({ plugins: [closeNamed()] })).rejects.toThrow(
      /"close" is reserved|Plugin name "close" is reserved/,
    );
  });

  test("boot, close, boot again in one file — the second app gets a live cache", async () => {
    // The stated driver for the whole close() effort: two real boots, two real
    // sockets, one process.
    //
    // Note what this does *not* prove. The cache here is InMemoryStorage, whose
    // close() merely clears a Map and stays usable, so this passes with or
    // without the singleton resets. The reset's necessity is proven in
    // cache/tests/cache-manager-reset.test.ts against storage whose close() is
    // terminal, the way PersistentStorage's pool.end() is.
    const termBaseline = process.listenerCount("SIGTERM");

    const first = await createApp({
      plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
    });
    const firstPort = await getListeningPort(first.server.getServer());
    await expect(
      fetch(`http://127.0.0.1:${firstPort}/health`).then((r) => r.status),
    ).resolves.toBe(200);
    await first.close();

    // ServiceContext was reset by close(), so the mock has to be reinstalled —
    // exactly what createTestApp will do for the caller.
    serviceContextMock.restore();
    serviceContextMock = mockServiceContext();

    const second = await createApp({
      plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
    });
    const secondPort = await getListeningPort(second.server.getServer());

    expect(secondPort).not.toBe(firstPort);
    await expect(
      fetch(`http://127.0.0.1:${secondPort}/health`).then((r) => r.status),
    ).resolves.toBe(200);

    // The second boot's cache round-trips a write.
    const cache = CacheManager.getInstanceSync();
    const key = cache.generateKey(["second-boot"], "test-user");
    await cache.set(key, { alive: true });
    await expect(cache.get(key)).resolves.toEqual({ alive: true });

    await second.close();

    await expect(
      fetch(`http://127.0.0.1:${secondPort}/health`),
    ).rejects.toThrow();
    // Two boots and two closes leave no listener residue.
    expect(process.listenerCount("SIGTERM")).toBe(termBaseline);
  });
  /**
   * Enforced by `tsc --noEmit`, not at runtime: the widening to `AppHandle<T>` is
   * only source-compatible if it stays assignable to `PluginMap<T>`, and a
   * regression there would break existing callers without failing any assertion.
   */
  describe("createApp return-type widening is source-compatible", () => {
    test("an AppHandle still satisfies a PluginMap annotation", async () => {
      const app = await createApp({ plugins: [probe()] });
      try {
        // The pre-widening annotation, unchanged.
        const asPluginMap: PluginMap<[ReturnType<typeof probe>]> = app;
        expect(typeof asPluginMap.probe.shutdownCalls).toBe("function");

        // And the added members are visible on the widened type.
        const asHandle: AppHandle<[ReturnType<typeof probe>]> = app;
        expect(typeof asHandle.close).toBe("function");
        expect(typeof asHandle[Symbol.asyncDispose]).toBe("function");
      } finally {
        await app.close();
      }
    });
  });

  test("a stale handle's second close() cannot reset a newer app", async () => {
    // Only reachable through the raw handle: createTestApp's wrapper memoizes
    // close(), which masked this.
    const first = await createApp({ plugins: [probe()] });
    await first.close();

    serviceContextMock.restore();
    serviceContextMock = mockServiceContext();
    const second = await createApp({
      plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
    });
    const port = await getListeningPort(second.server.getServer());

    try {
      // The phases are memoized, but the singleton release was not — so this
      // second call used to drop the singletons the *second* app was using.
      await first.close();

      await expect(
        fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status),
      ).resolves.toBe(200);
      expect(() => CacheManager.getInstanceSync()).not.toThrow();
      expect(() => ServiceContext.get()).not.toThrow();
    } finally {
      await second.close();
    }
  });
});
