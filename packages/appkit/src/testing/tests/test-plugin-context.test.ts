import type express from "express";
import { describe, expect, test } from "vitest";
import { PluginContext } from "../../core/plugin-context";
import { Plugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { createTestPluginContext } from "../test-plugin-context";

// A minimal real plugin for exercising attach() end-to-end.
class ProbePlugin extends Plugin {
  static manifest = {
    name: "probe",
    displayName: "Probe",
    description: "attach() probe",
    resources: { required: [], optional: [] },
  } as PluginManifest<"probe">;

  ready() {
    // `isReady` is protected; expose it for the attach() assertion.
    return (this as unknown as { isReady: boolean }).isReady;
  }

  register() {
    this.context?.addRoute("get", "/probe", (_req, res) => res.end());
  }
}

/**
 * Contract for `createTestPluginContext`. The point of the kit is that it wraps the
 * REAL PluginContext — so these tests drive the real `executeTool`,
 * `addRoute`, and `getToolProviders` and assert the observable seams (OBO,
 * timeout, route recording) rather than a reimplementation.
 */

// Default to a well-formed OBO request (user token + user id) so executeTool's
// asUser path resolves. Pass `{}` explicitly to model a token-less request.
function mockReq(
  headers: Record<string, string> = {
    "x-forwarded-access-token": "user-token",
    "x-forwarded-user": "alice",
  },
): express.Request {
  return {
    body: {},
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as express.Request;
}

describe("createTestPluginContext — construction", () => {
  test("produces a real PluginContext instance", () => {
    const { ctx } = createTestPluginContext();
    expect(ctx).toBeInstanceOf(PluginContext);
  });

  test("registers fake providers passed at construction", () => {
    const { ctx } = createTestPluginContext({
      analytics: { query: [{ id: 1 }] },
      genie: { ask: "hi" },
    });
    const names = ctx.getToolProviders().map((p) => p.name);
    expect(names).toContain("analytics");
    expect(names).toContain("genie");
  });
});

describe("createTestPluginContext — executeTool runs the REAL user-scoping path", () => {
  test("dispatches through asUser and returns the canned static response", async () => {
    const rows = [{ user: "alice", n: 3 }];
    const mock = createTestPluginContext({ analytics: { top_users: rows } });

    const result = await mock.ctx.executeTool(
      mockReq(),
      "analytics",
      "top_users",
      { limit: 10 },
    );

    expect(result).toEqual(rows);
    // executeTool resolves the user scope via provider.asUser(req), and the
    // fake resolves the user id from the request headers.
    expect(mock.toolCalls).toHaveLength(1);
    expect(mock.toolCalls[0]).toMatchObject({
      plugin: "analytics",
      tool: "top_users",
      args: { limit: 10 },
      asUser: true,
      userId: "alice",
    });
    // The OBO request object is the one we passed in.
    expect(mock.providers.get("analytics")?.asUserRequests).toHaveLength(1);
  });

  test("rejects a token-less request the way the real asUser does", async () => {
    // The fake asUser enforces the same token precondition as Plugin.asUser,
    // so a header-less request must reject rather than silently record
    // asUser: true — this is what makes the OBO assertion meaningful.
    const mock = createTestPluginContext({ analytics: { top_users: [] } });

    await expect(
      mock.ctx.executeTool(mockReq({}), "analytics", "top_users", {}),
    ).rejects.toThrow(/Missing user token/);
    // The dispatch never reached the tool.
    expect(mock.toolCalls).toHaveLength(0);
  });

  test("rejects a request with a token but no user id", async () => {
    const mock = createTestPluginContext({ analytics: { top_users: [] } });

    await expect(
      mock.ctx.executeTool(
        mockReq({ "x-forwarded-access-token": "tok" }),
        "analytics",
        "top_users",
        {},
      ),
    ).rejects.toThrow(/Missing user id|user id/i);
    expect(mock.toolCalls).toHaveLength(0);
  });

  test("records the resolved user id so a test can assert who the tool ran as", async () => {
    const mock = createTestPluginContext({ analytics: { top_users: [] } });
    await mock.ctx.executeTool(
      mockReq({
        "x-forwarded-access-token": "tok",
        "x-forwarded-user": "bob",
      }),
      "analytics",
      "top_users",
      {},
    );
    expect(mock.toolCalls[0]).toMatchObject({ asUser: true, userId: "bob" });
  });

  test("invokes a function response with the args and the composed signal", async () => {
    const mock = createTestPluginContext({
      analytics: {
        query: (args, signal) => ({ echoed: args, aborted: signal?.aborted }),
      },
    });

    const result = await mock.ctx.executeTool(mockReq(), "analytics", "query", {
      sql: "SELECT 1",
    });

    expect(result).toEqual({ echoed: { sql: "SELECT 1" }, aborted: false });
    // executeTool composes a timeout signal even when the caller passes none.
    expect(mock.toolCalls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("forwards the caller timeout so a slow tool is aborted", async () => {
    const mock = createTestPluginContext({
      slow: {
        wait: (_args, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted by timeout")),
            );
          }),
      },
    });

    // 5ms timeout — the tool never resolves on its own, so the composed
    // timeout signal must fire. This exercises executeTool's real
    // AbortSignal.timeout + AbortSignal.any composition.
    await expect(
      mock.ctx.executeTool(mockReq(), "slow", "wait", {}, undefined, 5),
    ).rejects.toThrow(/aborted by timeout/);
  });

  test("throws with a helpful message for an unknown plugin", async () => {
    const mock = createTestPluginContext({ analytics: { query: [] } });
    await expect(
      mock.ctx.executeTool(mockReq(), "nope", "query", {}),
    ).rejects.toThrow(/unknown plugin "nope"/);
  });

  test("throws with a helpful message for an unknown tool", async () => {
    const mock = createTestPluginContext({ analytics: { query: [] } });
    await expect(
      mock.ctx.executeTool(mockReq(), "analytics", "missing", {}),
    ).rejects.toThrow(/no fake tool "missing"/);
  });

  test("returns a null response as a value rather than treating it as missing", async () => {
    // `resolve` distinguishes a null fake response (valid) from undefined
    // (unregistered tool), so a tool can model an empty/absent result.
    const mock = createTestPluginContext({ analytics: { lookup: null } });
    const result = await mock.ctx.executeTool(
      mockReq(),
      "analytics",
      "lookup",
      {},
    );
    expect(result).toBeNull();
  });
});

describe("createTestPluginContext — telemetry seam", () => {
  test("records a span on the injected mock telemetry for each executeTool", async () => {
    const mock = createTestPluginContext({ analytics: { query: [] } });
    const tracer = mock.telemetry.getTracer();

    await mock.ctx.executeTool(mockReq(), "analytics", "query", {});

    // getTracer() is called inside executeTool; startActiveSpan drives the span.
    expect(tracer.startActiveSpan).toHaveBeenCalled();
  });
});

describe("createTestPluginContext — route recording", () => {
  test("records addRoute calls with raw (pre-wrap) handlers", () => {
    const mock = createTestPluginContext();
    const handler: express.RequestHandler = (_req, res) => {
      res.end();
    };

    mock.ctx.addRoute("post", "/invocations", handler);
    mock.ctx.addRoute("post", "/responses", handler);

    expect(mock.routes).toHaveLength(2);
    expect(mock.routes[0]).toMatchObject({
      method: "post",
      path: "/invocations",
    });
    // Raw handler references are preserved (PluginContext would otherwise wrap
    // them with forwardAsyncErrors, losing reference identity).
    expect(mock.routes[0]?.handlers[0]).toBe(handler);
    expect(mock.routes[1]?.handlers[0]).toBe(handler);
  });

  test("records addMiddleware under the 'use' method", () => {
    const mock = createTestPluginContext();
    const mw: express.RequestHandler = (_req, _res, next) => next();
    mock.ctx.addMiddleware("/api", mw);
    expect(mock.routes).toEqual([
      { method: "use", path: "/api", handlers: [mw] },
    ]);
  });
});

describe("createTestPluginContext — registerProvider after construction", () => {
  test("adds a provider dynamically", async () => {
    const mock = createTestPluginContext();
    mock.registerProvider("late", { ping: "pong" });
    const result = await mock.ctx.executeTool(mockReq(), "late", "ping", {});
    expect(result).toBe("pong");
  });
});

describe("createTestPluginContext — attach()", () => {
  test("seeds the cache, flips isReady, and registers the plugin", async () => {
    const mock = createTestPluginContext();
    const plugin = new ProbePlugin({});

    // Before attach the plugin may not be ready (no cache seeded yet in a
    // fresh process); after attach it is, and it is in the context registry.
    const returned = await mock.attach(plugin);

    expect(returned).toBe(plugin);
    expect(plugin.ready()).toBe(true);
    expect(mock.ctx.getPluginNames()).toContain("probe");
    expect(mock.ctx.hasPlugin("probe")).toBe(true);

    // A route the plugin registers post-attach is captured through the context.
    plugin.register();
    expect(mock.routes).toContainEqual(
      expect.objectContaining({ method: "get", path: "/probe" }),
    );
  });

  test("does not overwrite an injected fake provider of the same name", async () => {
    // If the plugin under test shares a name with an injected fake, the fake
    // (the authored double) must win — attach must not clobber it.
    const mock = createTestPluginContext({ probe: { canned: "fake" } });
    const plugin = new ProbePlugin({});
    await mock.attach(plugin);

    const result = await mock.ctx.executeTool(mockReq(), "probe", "canned", {});
    expect(result).toBe("fake");
  });
});
