import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ServiceContext } from "../../../context/service-context";
import { OmnigentPlugin } from "../omnigent";

const HOST = "https://ws.example.com";

type Route = (
  init: RequestInit,
  url: URL,
) => { status?: number; body?: unknown };

function plugin(config = {}) {
  const p = new OmnigentPlugin(config);
  const { router, getHandler } = createMockRouter();
  p.injectRoutes(router);
  return { p, getHandler };
}

async function call(
  handler: (req: unknown, res: unknown) => Promise<void>,
  req: object,
) {
  const res = createMockResponse();
  await handler(createMockRequest(req), res);
  return res;
}

const user = { token: "user-tok", userId: "u1", email: "alice@example.com" };

describe("OmnigentPlugin routes", () => {
  let routes: Record<string, Route>;
  let calls: Array<{
    method: string;
    url: string;
    auth: string | null;
    body: unknown;
  }>;

  beforeEach(() => {
    process.env.DATABRICKS_APP_NAME = "orders-app";
    vi.spyOn(ServiceContext, "get").mockReturnValue({
      client: {
        config: {
          getHost: async () => new URL(HOST),
          authenticate: async (h: Headers) =>
            h.set("Authorization", "Bearer dev-tok"),
        },
      },
    } as never);
    routes = {};
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        const method = init.method ?? "GET";
        const headers = new Headers(init.headers);
        calls.push({
          method,
          url: url.pathname + url.search,
          auth: headers.get("Authorization"),
          body:
            typeof init.body === "string" ? JSON.parse(init.body) : init.body,
        });
        const route = routes[`${method} ${url.pathname}`];
        const out = route ? route(init, url) : { status: 404, body: {} };
        return new Response(JSON.stringify(out.body ?? {}), {
          status: out.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    delete process.env.DATABRICKS_APP_NAME;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("registers the session API", () => {
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
      ["PUT", "/sessions/:id/mode"],
      ["POST", "/sessions/:id/elicitations/:eid"],
      ["GET", "/sessions/:id/stream"],
    ]) {
      expect(getHandler(m, path), `${m} ${path}`).toBeTypeOf("function");
    }
  });

  test("needs a forwarded user token outside development", async () => {
    const { getHandler } = plugin();
    const res = await call(getHandler("GET", "/sessions"), {});
    expect(res.status).toHaveBeenCalledWith(401);
    expect(calls).toEqual([]);
  });

  test("calls managed Omnigent with the user's token and lists only this app's sessions", async () => {
    routes["GET /api/2.0/omnigent/v1/sessions"] = () => ({
      body: { data: [] },
    });
    const { getHandler } = plugin();
    await call(getHandler("GET", "/sessions"), { obo: user });
    expect(calls).toEqual([
      {
        method: "GET",
        url: "/api/2.0/omnigent/v1/sessions?agent_name=orders-app&limit=100",
        auth: "Bearer user-tok",
        body: undefined,
      },
    ]);
  });

  test("explains the all-apis setup step when Omnigent rejects the token's scope", async () => {
    routes["GET /api/2.0/omnigent/v1/sessions"] = () => ({
      status: 403,
      body: { message: "Invalid scope, required scopes: all-apis" },
    });
    const { getHandler } = plugin();
    const res = await call(getHandler("GET", "/sessions"), { obo: user });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error).toMatch(
      /custom-app-integration update/,
    );
  });

  test("hides sessions another app created", async () => {
    routes["GET /api/2.0/omnigent/v1/sessions/s1"] = () => ({
      body: { id: "s1", labels: { app: "other-app" } },
    });
    const { getHandler } = plugin();
    const res = await call(getHandler("POST", "/sessions/:id/messages"), {
      obo: user,
      params: { id: "s1" },
      body: { text: "hi" },
    });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("creates a managed session with the app's agent and sends the first message", async () => {
    routes["GET /api/2.1/unity-catalog/model-services"] = () => ({
      body: {
        model_services: [
          {
            name: "system.ai.claude-sonnet-5",
            supported_api_types: ["anthropic/v1/messages"],
          },
        ],
      },
    });
    let metadata: Record<string, unknown> = {};
    routes["POST /api/2.0/omnigent/v1/sessions"] = (init) => {
      metadata = JSON.parse(String((init.body as FormData).get("metadata")));
      return { status: 201, body: { session_id: "s9" } };
    };
    routes["POST /api/2.0/omnigent/v1/sessions/s9/events"] = () => ({
      status: 202,
      body: { queued: true },
    });
    routes["GET /api/2.0/omnigent/v1/sessions/s9/policies"] = () => ({
      body: { data: [] },
    });
    const policies: unknown[] = [];
    routes["POST /api/2.0/omnigent/v1/sessions/s9/policies"] = (init) => {
      policies.push(JSON.parse(String(init.body)));
      return { body: {} };
    };
    const { getHandler } = plugin({
      instructions: "Help with orders.",
      tools: [{ type: "sql" }],
    });
    const res = await call(getHandler("POST", "/sessions"), {
      obo: user,
      body: { harness: "claude-sdk", message: "How many orders?" },
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      session_id: "s9",
      harness: "claude-sdk",
      model: "system.ai.claude-sonnet-5",
      mode: "ask",
    });
    // ask mode: Databricks SQL's execute_sql pauses for approval
    expect(policies.map((p) => (p as { name: string }).name)).toEqual([
      "appkit-mode-ask",
      "appkit-mode-os",
    ]);
    expect(JSON.stringify(policies[0])).toContain("execute_sql");
    expect(metadata).toMatchObject({
      host_type: "managed",
      labels: { app: "orders-app" },
      title: "How many orders?",
    });
    expect(calls.at(-1)?.body).toMatchObject({
      type: "message",
      data: { role: "user" },
    });
    expect(calls.every((c) => c.auth === "Bearer user-tok")).toBe(true);
  });

  test("rejects a model the harness cannot drive", async () => {
    routes["GET /api/2.1/unity-catalog/model-services"] = () => ({
      body: {
        model_services: [
          {
            name: "system.ai.gpt-5-5",
            supported_api_types: ["codex/v1/responses"],
          },
        ],
      },
    });
    const { getHandler } = plugin();
    const res = await call(getHandler("POST", "/sessions"), {
      obo: user,
      body: { harness: "claude-sdk", model: "system.ai.gpt-5-5" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("resolves an approval only with accept, decline or cancel", async () => {
    routes["GET /api/2.0/omnigent/v1/sessions/s1"] = () => ({
      body: { id: "s1", labels: { app: "orders-app" } },
    });
    routes["POST /api/2.0/omnigent/v1/sessions/s1/elicitations/e1/resolve"] =
      () => ({
        body: { ok: true },
      });
    const { getHandler } = plugin();
    const handler = getHandler("POST", "/sessions/:id/elicitations/:eid");
    let res = await call(handler, {
      obo: user,
      params: { id: "s1", eid: "e1" },
      body: { action: "approve" },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    res = await call(handler, {
      obo: user,
      params: { id: "s1", eid: "e1" },
      body: { action: "accept" },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/2.0/omnigent/v1/sessions/s1/elicitations/e1/resolve",
      body: { action: "accept" },
    });
  });

  test("status reports when Sandbox hosts are not enabled", async () => {
    routes["GET /api/2.0/omnigent/v1/info"] = () => ({
      body: { server_version: "0.18.0", managed_sandboxes_enabled: false },
    });
    const { getHandler } = plugin();
    const res = await call(getHandler("GET", "/status"), { obo: user });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ready: false,
        version: "0.18.0",
        sandboxes: false,
      }),
    );
  });
});
