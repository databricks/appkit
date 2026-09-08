import { createTestApp } from "@databricks/appkit/testing";
import { describe, expect, test, vi } from "vitest";

import { lakebaseExamples } from "./lakebase-examples-plugin";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

/**
 * Smoke tests for the playground's own server plugins.
 *
 * `tests/` holds Playwright specs that fake `/api` responses at the browser
 * boundary (`page.route` + `fulfill`), so the Express server never runs there.
 * These cover the other side: the plugins boot and answer over real HTTP with
 * the Databricks data plane faked by the harness — no workspace, no
 * credentials, no network.
 */

/**
 * Read one SSE payload, then hang up.
 *
 * `expectStream` buffers a source to completion, and the reconnect stream is
 * five messages three seconds apart — so asserting through it would cost ~12s
 * for a smoke test.
 */
async function firstSSEPayload(res: Response): Promise<unknown> {
  if (!res.body) throw new Error("expected a streaming body, got none");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (!buffered.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
    const data = buffered.split("\n").find((line) => line.startsWith("data:"));
    return data ? JSON.parse(data.slice("data:".length).trim()) : undefined;
  } finally {
    await reader.cancel();
  }
}

describe("dev-playground server plugins", () => {
  test("all three boot together and register under their manifest names", async () => {
    await using app = await createTestApp({
      plugins: [reconnect(), telemetryExamples(), lakebaseExamples()],
    });

    expect(app.plugins.reconnect).toBeDefined();
    expect(app.plugins["telemetry-examples"]).toBeDefined();
    expect(app.plugins["lakebase-examples"]).toBeDefined();
  });

  test("GET /api/reconnect answers", async () => {
    await using app = await createTestApp({ plugins: [reconnect()] });

    const res = await app.get("/api/reconnect");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ message: "Reconnected" });
  });

  test("the reconnect stream opens as SSE and emits its first message", async () => {
    await using app = await createTestApp({ plugins: [reconnect()] });

    const res = await app.get("/api/reconnect/stream?sessionId=smoke");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await expect(firstSSEPayload(res)).resolves.toMatchObject({
      type: "message",
      count: 1,
      total: 5,
      content: "Message 1 of 5",
    });
  });

  test("POST /api/telemetry-examples/combined threads the userId through every span", async () => {
    // This route really calls `fetch("https://example.com")` (its
    // external-api span). Left alone the suite would need the internet, so
    // non-loopback requests are stubbed — loopback must pass through, because
    // that is how the harness reaches its own server.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return /127\.0\.0\.1|localhost/.test(url)
        ? realFetch(input, init)
        : Promise.resolve(new Response("stubbed", { status: 200 }));
    });

    try {
      await using app = await createTestApp({ plugins: [telemetryExamples()] });

      const res = await app.post("/api/telemetry-examples/combined", {
        body: { userId: "smoke-user" },
      });

      expect(res.status).toBe(200);
      // A 200 means the whole nested-span body ran against the real
      // TelemetryProvider: tracer, meter, and logger.
      await expect(res.json()).resolves.toMatchObject({
        success: true,
        result: { userId: "smoke-user" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("lakebase-examples degrades to no routes when Lakebase is unconfigured", async () => {
    // Its setup() and injectRoutes() both bail on missing PGHOST/LAKEBASE_ENDPOINT.
    // The app must still boot; the routes must simply be absent.
    await using app = await createTestApp({
      plugins: [lakebaseExamples()],
      env: { PGHOST: "", LAKEBASE_ENDPOINT: "" },
    });

    expect(app.plugins["lakebase-examples"]).toBeDefined();
    expect((await app.get("/api/lakebase-examples/raw")).status).toBe(404);
  });
});
