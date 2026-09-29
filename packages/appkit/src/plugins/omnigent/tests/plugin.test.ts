import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import {
  getExecutionContext,
  isInUserContext,
} from "../../../context/execution-context";
import { ServiceContext } from "../../../context/service-context";
import { defineTool } from "../../../core/agent/tools/define-tool";
import { SessionKeys } from "../keys";
import { OmnigentPlugin } from "../omnigent";

const SECRET = "test-key-secret";

function plugin() {
  const seen: Array<{ inUserContext: boolean; client: unknown }> = [];
  const p = new OmnigentPlugin({
    tools: {
      whoami: defineTool({
        description: "Who is calling",
        schema: z.object({}),
        annotations: { effect: "read" },
        execute: async () => {
          seen.push({
            inUserContext: isInUserContext(),
            client: getExecutionContext().client,
          });
          return { ok: true };
        },
      }),
      "notes.save": defineTool({
        description: "Save",
        schema: z.object({ text: z.string() }),
        annotations: { effect: "write" },
        execute: async () => ({ saved: true }),
      }),
    },
  });
  const { router, getHandler } = createMockRouter();
  p.injectRoutes(router);
  return { p, getHandler, seen };
}

async function call(
  handler: (req: unknown, res: unknown) => Promise<void>,
  req: object,
) {
  const res = createMockResponse();
  await handler(createMockRequest(req), res);
  return res;
}

describe("OmnigentPlugin routes", () => {
  let ctx: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    process.env.OMNIGENT_KEY_SECRET = SECRET;
    delete process.env.DATABRICKS_CLIENT_SECRET;
    ctx = await mockServiceContext({});
  });

  afterEach(() => {
    ctx?.restore();
    delete process.env.OMNIGENT_KEY_SECRET;
    vi.restoreAllMocks();
  });

  test("registers the session API and the MCP endpoint", () => {
    const { getHandler } = plugin();
    for (const [m, path] of [
      ["GET", "/status"],
      ["GET", "/harnesses"],
      ["GET", "/sessions"],
      ["POST", "/sessions"],
      ["GET", "/sessions/:id"],
      ["DELETE", "/sessions/:id"],
      ["POST", "/sessions/:id/messages"],
      ["POST", "/sessions/:id/interrupt"],
      ["POST", "/sessions/:id/elicitations/:eid"],
      ["PUT", "/sessions/:id/mode"],
      ["GET", "/sessions/:id/stream"],
      ["POST", "/mcp"],
    ]) {
      expect(getHandler(m, path), `${m} ${path}`).toBeTypeOf("function");
    }
  });

  test("a signed-in request before the runtime starts gets 503, not a crash", async () => {
    const { getHandler } = plugin();
    const res = await call(getHandler("GET", "/sessions"), {
      obo: { token: "t", userId: "u", email: "a@example.com" },
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test("session routes need a forwarded identity", async () => {
    const { getHandler } = plugin();
    const res = await call(getHandler("GET", "/sessions"), {});
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("MCP rejects calls without a valid session key", async () => {
    const { getHandler } = plugin();
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    let res = await call(getHandler("POST", "/mcp"), { body });
    expect(res.status).toHaveBeenCalledWith(401);
    const forged = new SessionKeys("some-other-secret").mint("alice-id");
    res = await call(getHandler("POST", "/mcp"), {
      body,
      headers: new SessionKeys().headers(forged),
    });
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("MCP runs tools as the key's user, with their latest forwarded token", async () => {
    const { getHandler, seen } = plugin();
    const keys = new SessionKeys(SECRET);
    const headers = keys.headers(keys.mint("alice-id"));

    // Before alice has made a request, there is no token to act with.
    let res = await call(getHandler("POST", "/mcp"), {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "whoami" },
      },
      headers,
    });
    expect(res.json.mock.calls[0][0].error.message).toMatch(
      /Open the app again/,
    );

    // A request from alice records her identity (the route itself fails: no runtime).
    await call(getHandler("GET", "/sessions"), {
      obo: {
        token: "alice-token",
        userId: "alice-id",
        email: "alice@example.com",
      },
    });

    res = await call(getHandler("POST", "/mcp"), {
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      },
      headers,
    });
    const reply = res.json.mock.calls[0][0];
    expect(reply.result.content[0].text).toBe('{"ok":true}');
    expect(seen).toHaveLength(1);
    expect(seen[0].inUserContext).toBe(true);
    expect(ctx.createUserContextSpy).toHaveBeenCalledWith(
      "alice-token",
      "alice-id",
      undefined,
      "alice@example.com",
    );
  });

  test("tools/list serves MCP-safe names", async () => {
    const { getHandler } = plugin();
    const keys = new SessionKeys(SECRET);
    await call(getHandler("GET", "/sessions"), {
      obo: { token: "t", userId: "u", email: "bob@example.com" },
    });
    const res = await call(getHandler("POST", "/mcp"), {
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      headers: keys.headers(keys.mint("u")),
    });
    const names = res.json.mock.calls[0][0].result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(names).toEqual(["whoami", "notes_save"]);
  });

  test("notifications get 202 with no body", async () => {
    const { getHandler } = plugin();
    const keys = new SessionKeys(SECRET);
    await call(getHandler("GET", "/sessions"), {
      obo: { token: "t", userId: "u", email: "c@example.com" },
    });
    const res = await call(getHandler("POST", "/mcp"), {
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      headers: keys.headers(keys.mint("u")),
    });
    expect(res.status).toHaveBeenCalledWith(202);
  });
});
