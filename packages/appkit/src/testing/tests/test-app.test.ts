import type { PluginManifest } from "shared";
import { describe, expect, test } from "vitest";

import { Plugin, toPlugin } from "../../plugin";
import { createTestApp } from "../create-test-app";
import { useTestApp } from "../test-app";

/**
 * The behaviour that matters is the hook wiring: a fresh app per test, closed
 * after each, with no `close()` for the caller to forget. The harness allows one
 * open app at a time, so "the previous test's app was really closed" is
 * observable — a leak makes the next boot throw.
 */

class ProbePlugin extends Plugin {
  static manifest = {
    name: "probe",
    displayName: "Probe",
    version: "0.0.0",
    description: "useTestApp probe",
    resources: { required: [], optional: [] },
  } as unknown as PluginManifest;

  injectRoutes(router: never): void {
    this.route(router, {
      name: "ping",
      method: "get",
      path: "/ping",
      handler: async (_req, res) => {
        res.json({ pong: true });
      },
    });
  }
}
const probe = toPlugin(ProbePlugin);

describe("useTestApp", () => {
  const app = useTestApp({ plugins: [probe()] });

  test("boots an app and serves a route inside a test", async () => {
    const res = await app.current.get("/api/probe/ping");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ pong: true });
  });

  test("the previous test's app was closed, so this boot succeeded", async () => {
    // If afterEach had not closed it, the one-app-at-a-time guard would have
    // thrown during this test's beforeEach and never reached the body.
    expect(app.current.port).toBeGreaterThan(0);
  });

  test("hands out a different app than the previous test", async () => {
    const res = await app.current.get("/api/probe/ping");
    expect(res.status).toBe(200);
  });
});

describe("useTestApp passes options through", () => {
  const app = useTestApp({
    plugins: [probe()],
    env: { USE_TEST_APP_PROBE: "set" },
  });

  test("env reaches the boot", () => {
    expect(process.env.USE_TEST_APP_PROBE).toBe("set");
  });
});

describe("useTestApp cleans up after the file's suites", () => {
  test("env from the previous suite was restored on close", () => {
    expect(process.env.USE_TEST_APP_PROBE).toBeUndefined();
  });

  test("no app is held open, so a manual boot is allowed", async () => {
    // The guard makes this the discriminating check: it only passes if every
    // app useTestApp booted above was actually closed.
    await using manual = await createTestApp({ plugins: [probe()] });
    expect(manual.port).toBeGreaterThan(0);
  });
});

describe("useTestApp misuse", () => {
  test("reading .current outside a registered test explains itself", () => {
    const stray = useTestApp({ plugins: [probe()] });
    expect(() => stray.current).toThrow(/no active app/);
  });
});
