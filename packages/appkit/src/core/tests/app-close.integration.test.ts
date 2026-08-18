import type { Server } from "node:http";

import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import type { PluginManifest } from "shared";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ServiceContext } from "../../context/service-context";
import { ConfigurationError } from "../../errors";
import { Plugin, toPlugin } from "../../plugin";
import { server as serverPlugin } from "../../plugins/server";
import { createApp } from "../appkit";

/**
 * Integration coverage for the app handle's `close()`.
 *
 * Deliberately unmocked: the whole claim is that `close()` releases *real*
 * resources — a bound socket, the plugin hooks, the signal handlers — so a
 * mocked lifecycle would assert nothing. Every boot here uses `port: 0` so the
 * OS assigns an ephemeral port and the suite stays parallel-safe.
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

/**
 * `server.start()` returns as soon as `listen()` is invoked, before the bind
 * completes, so `address()` is null until the `listening` event fires.
 */
async function listeningPort(server: Server): Promise<number> {
  const addr = server.address();
  if (addr && typeof addr === "object") return addr.port;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const ready = server.address();
  if (!ready || typeof ready !== "object") {
    throw new Error("listening but address() was null");
  }
  return ready.port;
}

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

    const port = await listeningPort(app.server.getServer());
    const baseUrl = `http://127.0.0.1:${port}`;
    await expect(
      fetch(`${baseUrl}/health`).then((r) => r.status),
    ).resolves.toBe(200);

    await app.close();

    // The plugin's own teardown hook ran...
    expect(app.probe.shutdownCalls()).toBe(1);
    // ...the listener is gone...
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
    // ...and the signal handlers came back off, which is what keeps repeated
    // boots from tripping MaxListenersExceededWarning.
    expect(process.listenerCount("SIGTERM")).toBe(termBaseline);
  });

  test("is idempotent at the app level", async () => {
    const app = await createApp({
      plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
    });
    await listeningPort(app.server.getServer());

    await app.close();
    await expect(app.close()).resolves.toBeUndefined();

    // The memo means the phases ran once, not twice.
    expect(app.probe.shutdownCalls()).toBe(1);
  });

  test("plugin exports stay reachable by name alongside close()", async () => {
    const app = await createApp({
      plugins: [probe(), serverPlugin({ port: 0, host: "127.0.0.1" })],
    });
    await listeningPort(app.server.getServer());

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
      captured = await listeningPort(app.server.getServer());
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
});
