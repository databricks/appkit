import type express from "express";
import { describe, expect, test } from "vitest";
import { PluginContext } from "../../core/plugin-context";
import { mockPluginContext } from "../mock-plugin-context";

/**
 * Contract for `mockPluginContext`. The point of the kit is that it wraps the
 * REAL PluginContext — so these tests drive the real `executeTool`,
 * `addRoute`, and `getToolProviders` and assert the observable seams (OBO,
 * timeout, route recording) rather than a reimplementation.
 */

function mockReq(headers: Record<string, string> = {}): express.Request {
  return {
    body: {},
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as express.Request;
}

describe("mockPluginContext — construction", () => {
  test("produces a real PluginContext instance", () => {
    const { ctx } = mockPluginContext();
    expect(ctx).toBeInstanceOf(PluginContext);
  });

  test("registers fake providers passed at construction", () => {
    const { ctx } = mockPluginContext({
      analytics: { query: [{ id: 1 }] },
      genie: { ask: "hi" },
    });
    const names = ctx.getToolProviders().map((p) => p.name);
    expect(names).toContain("analytics");
    expect(names).toContain("genie");
  });
});

describe("mockPluginContext — executeTool runs the REAL user-scoping path", () => {
  test("dispatches through asUser and returns the canned static response", async () => {
    const rows = [{ user: "alice", n: 3 }];
    const mock = mockPluginContext({ analytics: { top_users: rows } });

    const result = await mock.ctx.executeTool(
      mockReq(),
      "analytics",
      "top_users",
      { limit: 10 },
    );

    expect(result).toEqual(rows);
    // executeTool always resolves the user scope via provider.asUser(req).
    expect(mock.toolCalls).toHaveLength(1);
    expect(mock.toolCalls[0]).toMatchObject({
      plugin: "analytics",
      tool: "top_users",
      args: { limit: 10 },
      asUser: true,
    });
    // The OBO request object is the one we passed in.
    expect(mock.providers.get("analytics")?.asUserRequests).toHaveLength(1);
  });

  test("invokes a function response with the args and the composed signal", async () => {
    const mock = mockPluginContext({
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
    const mock = mockPluginContext({
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
    const mock = mockPluginContext({ analytics: { query: [] } });
    await expect(
      mock.ctx.executeTool(mockReq(), "nope", "query", {}),
    ).rejects.toThrow(/unknown plugin "nope"/);
  });

  test("throws with a helpful message for an unknown tool", async () => {
    const mock = mockPluginContext({ analytics: { query: [] } });
    await expect(
      mock.ctx.executeTool(mockReq(), "analytics", "missing", {}),
    ).rejects.toThrow(/no fake tool "missing"/);
  });

  test("returns a null response as a value rather than treating it as missing", async () => {
    // `resolve` distinguishes a null fake response (valid) from undefined
    // (unregistered tool), so a tool can model an empty/absent result.
    const mock = mockPluginContext({ analytics: { lookup: null } });
    const result = await mock.ctx.executeTool(
      mockReq(),
      "analytics",
      "lookup",
      {},
    );
    expect(result).toBeNull();
  });
});

describe("mockPluginContext — telemetry seam", () => {
  test("records a span on the injected mock telemetry for each executeTool", async () => {
    const mock = mockPluginContext({ analytics: { query: [] } });
    const tracer = mock.telemetry.getTracer();

    await mock.ctx.executeTool(mockReq(), "analytics", "query", {});

    // getTracer() is called inside executeTool; startActiveSpan drives the span.
    expect(tracer.startActiveSpan).toHaveBeenCalled();
  });
});

describe("mockPluginContext — route recording", () => {
  test("records addRoute calls with raw (pre-wrap) handlers", () => {
    const mock = mockPluginContext();
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
    const mock = mockPluginContext();
    const mw: express.RequestHandler = (_req, _res, next) => next();
    mock.ctx.addMiddleware("/api", mw);
    expect(mock.routes).toEqual([
      { method: "use", path: "/api", handlers: [mw] },
    ]);
  });
});

describe("mockPluginContext — registerProvider after construction", () => {
  test("adds a provider dynamically", async () => {
    const mock = mockPluginContext();
    mock.registerProvider("late", { ping: "pong" });
    const result = await mock.ctx.executeTool(mockReq(), "late", "ping", {});
    expect(result).toBe("pong");
  });
});
