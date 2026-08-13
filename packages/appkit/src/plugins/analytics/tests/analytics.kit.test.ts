import type express from "express";
import { describe, expect, test } from "vitest";
import { createMockRequest, createTestPluginContext } from "../../../testing";

/**
 * Dogfooding `@databricks/appkit/testing` for the cross-plugin tool-call (OBO)
 * scenario — the case `createTestPluginContext` is purpose-built for.
 *
 * A plugin that consumes another plugin's tools calls
 * `this.context.executeTool(pluginName, toolName, ...)`. Here we register a
 * fake `analytics` provider and drive that dispatch, asserting both the result
 * and that it resolved through the user's identity (the on-behalf-of path that
 * silent `{ executeTool }` stubs could never verify).
 *
 * This needs ONLY the kit — no workspace, no ServiceContext, no network — which
 * is the sweet spot noted in internal/testing-kit-dogfooding.md. (Driving
 * analytics' own SQL handlers, by contrast, still needs the ServiceContext /
 * workspace-client fixtures because that work lives behind those seams.)
 */

describe("analytics as a cross-plugin tool provider — dogfooding the kit", () => {
  test("a consumer dispatches analytics.query on-behalf-of the user", async () => {
    const rows = [{ customer: "Acme", revenue: 1_000_000 }];
    const mock = createTestPluginContext({
      analytics: {
        // A canned result for the analytics `query` tool.
        query: (args) => ({ rows, echoedArgs: args }),
      },
    });

    // Simulate what a consumer plugin (e.g. agents) does internally: resolve a
    // sibling plugin's tool through the shared PluginContext.
    const req = createMockRequest({
      obo: { userId: "analyst@example.com" },
    }) as unknown as express.Request;
    const result = await mock.ctx.executeTool(req, "analytics", "query", {
      sql: "SELECT * FROM top_customers",
    });

    expect(result).toEqual({
      rows,
      echoedArgs: { sql: "SELECT * FROM top_customers" },
    });

    // Prove the dispatch ran as the end user, not the service principal.
    expect(mock.toolCalls).toHaveLength(1);
    expect(mock.toolCalls[0]).toMatchObject({
      plugin: "analytics",
      tool: "query",
      asUser: true,
      userId: "analyst@example.com",
    });
  });

  test("a token-less request is rejected before the tool runs", async () => {
    const mock = createTestPluginContext({
      analytics: { query: () => ({ rows: [] }) },
    });

    // No `obo` — a request with no forwarded token must be rejected.
    const req = createMockRequest() as unknown as express.Request;
    await expect(
      mock.ctx.executeTool(req, "analytics", "query", {}),
    ).rejects.toThrow(/Missing user token/);
    expect(mock.toolCalls).toHaveLength(0);
  });

  test("the per-call timeout the caller forwards actually aborts a slow tool", async () => {
    const mock = createTestPluginContext({
      analytics: {
        query: (_args, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted by timeout")),
            );
          }),
      },
    });

    const req = createMockRequest({ obo: true }) as unknown as express.Request;
    await expect(
      mock.ctx.executeTool(
        req,
        "analytics",
        "query",
        {},
        undefined,
        5, // 5ms timeout
      ),
    ).rejects.toThrow(/aborted by timeout/);
  });
});
