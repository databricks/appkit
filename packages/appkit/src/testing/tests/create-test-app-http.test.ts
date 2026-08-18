import type {
  IAppRequest,
  IAppResponse,
  IAppRouter,
  PluginManifest,
} from "shared";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { getUserContext } from "../../context/execution-context";
import { Plugin, toPlugin } from "../../plugin";
import { createTestApp, type TestApp } from "../create-test-app";
import { expectStream } from "../expect-stream";

/**
 * The HTTP layer: `app.get/post/put/patch/delete` against a real Express stack.
 *
 * One app for the whole file — every assertion here is about the request, not
 * about boot, so re-booting per test would only slow it down.
 */

class HttpPlugin extends Plugin {
  static manifest = {
    name: "http",
    displayName: "Http",
    version: "0.0.0",
    description: "HTTP layer probe",
    resources: { required: [], optional: [] },
  } as unknown as PluginManifest;

  injectRoutes(router: IAppRouter): void {
    // Registered through `this.route()`, the way real plugins do, rather than
    // raw `router.get()`. That is what wraps each handler in
    // forwardAsyncErrors, so a rejection reaches errorHandlerMiddleware instead
    // of hanging the request — see the /boom test.
    const get = (
      name: string,
      path: string,
      handler: (req: IAppRequest, res: IAppResponse) => Promise<void>,
    ) => this.route(router, { name, method: "get", path, handler });

    get("json", "/json", async (_req, res) => {
      res.status(201).json({ ok: true, method: "GET" });
    });

    this.route(router, {
      name: "echo",
      method: "post",
      path: "/echo",
      handler: async (req, res) => {
        res.json({
          body: req.body,
          contentType: req.headers["content-type"] ?? null,
        });
      },
    });

    get("headers", "/headers", async (req, res) => {
      res.json({
        custom: req.headers["x-custom"] ?? null,
        user: req.headers["x-forwarded-user"] ?? null,
        token: req.headers["x-forwarded-access-token"] ?? null,
        email: req.headers["x-forwarded-email"] ?? null,
      });
    });

    // Uses the real asUser path, so the forwarded identity has to be genuine.
    get("asUser", "/as-user", async (req, res) => {
      const exports = this.asUser(req).exports() as {
        whoami: () => { userId?: string };
      };
      res.json(exports.whoami());
    });

    get("boom", "/boom", async () => {
      throw new Error("handler exploded");
    });

    this.route(router, {
      name: "stream",
      method: "post",
      path: "/stream",
      handler: async (_req, res) => {
        res.setHeader("content-type", "text/event-stream");
        res.write(`event: status\ndata: ${JSON.stringify({ s: "start" })}\n\n`);
        res.write(`event: result\ndata: ${JSON.stringify({ rows: [1] })}\n\n`);
        res.end();
      },
    });

    for (const method of ["put", "patch"] as const) {
      this.route(router, {
        name: `verb-${method}`,
        method,
        path: "/verb",
        handler: async (req, res) => {
          res.json({ m: method.toUpperCase(), b: req.body });
        },
      });
    }
    this.route(router, {
      name: "verb-delete",
      method: "delete",
      path: "/verb",
      handler: async (_req, res) => {
        res.json({ m: "DELETE" });
      },
    });
  }

  exports() {
    return {
      whoami: () => {
        const ctx = getUserContext();
        return { userId: ctx?.userId };
      },
    };
  }
}
const http = toPlugin(HttpPlugin);

describe("createTestApp HTTP layer", () => {
  let app: TestApp<[ReturnType<typeof http>]>;

  beforeAll(async () => {
    app = await createTestApp({ plugins: [http()] });
  });

  afterAll(async () => {
    await app?.close();
  });

  test("GET returns the plugin's JSON body and status", async () => {
    const res = await app.get("/api/http/json");
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true, method: "GET" });
  });

  test("POST with an object body arrives JSON-parsed at the handler", async () => {
    const res = await app.post("/api/http/echo", {
      body: { q: 1, nested: [2] },
    });

    // Proves the real express.json() middleware ran, not a shortcut.
    await expect(res.json()).resolves.toEqual({
      body: { q: 1, nested: [2] },
      contentType: "application/json",
    });
  });

  test("POST with a string body and explicit content-type passes through unmodified", async () => {
    const res = await app.post("/api/http/echo", {
      body: "raw text, not JSON",
      headers: { "content-type": "text/plain" },
    });

    // express.json() ignores a non-JSON content-type, so the handler sees an
    // empty body — the point is that the harness did not re-encode or override.
    await expect(res.json()).resolves.toMatchObject({
      contentType: "text/plain",
    });
  });

  test("custom headers reach the handler and win over harness defaults", async () => {
    const res = await app.get("/api/http/headers", {
      obo: true,
      headers: { "x-custom": "hello", "x-forwarded-user": "override" },
    });

    await expect(res.json()).resolves.toMatchObject({
      custom: "hello",
      // The explicit header beats the one `obo` generated.
      user: "override",
      token: "test-user-token",
    });
  });

  test("obo: true sets the forwarded identity headers", async () => {
    const res = await app.get("/api/http/headers", { obo: true });
    await expect(res.json()).resolves.toMatchObject({
      user: "test-user",
      token: "test-user-token",
    });
  });

  test("obo: { userId, email } overrides the identity", async () => {
    const res = await app.get("/api/http/headers", {
      obo: { userId: "alice", email: "alice@example.com" },
    });
    await expect(res.json()).resolves.toMatchObject({
      user: "alice",
      email: "alice@example.com",
    });
  });

  test("a handler using asUser resolves the forwarded test user", async () => {
    const res = await app.get("/api/http/as-user", { obo: { userId: "bob" } });
    // The real user-context path, driven entirely by the `obo` flag.
    await expect(res.json()).resolves.toEqual({ userId: "bob" });
  });

  test("an SSE route composes with expectStream directly", async () => {
    // The dogfooding report's #1 friction, avoided by construction: the request
    // methods return a native Response, which expectStream already accepts.
    const res = await app.post("/api/http/stream");
    await expectStream(res).toEmit("status", "result");
  });

  test("a throwing handler produces the real error-middleware response", async () => {
    const res = await app.get("/api/http/boom");

    // Handled by the real errorHandlerMiddleware rather than escaping as an
    // unhandled rejection that would hang the request and fail the run.
    expect(res.status).toBe(500);

    // The message is included because errorHandlerMiddleware redacts only when
    // NODE_ENV === "production", and the harness pins "test". That is the
    // useful behaviour for a test — an assertion can name the failure — but it
    // does mean this response shape is the dev one, not what a deployed app
    // returns to a client.
    await expect(res.json()).resolves.toEqual({ error: "handler exploded" });
  });

  test("an unmounted path is a 404", async () => {
    const res = await app.get("/api/http/nope");
    expect(res.status).toBe(404);
  });

  test("put, patch, and delete reach their handlers", async () => {
    await expect(
      app.put("/api/http/verb", { body: { a: 1 } }).then((r) => r.json()),
    ).resolves.toEqual({ m: "PUT", b: { a: 1 } });
    await expect(
      app.patch("/api/http/verb", { body: { a: 2 } }).then((r) => r.json()),
    ).resolves.toEqual({ m: "PATCH", b: { a: 2 } });
    await expect(
      app.delete("/api/http/verb").then((r) => r.json()),
    ).resolves.toEqual({ m: "DELETE" });
  });

  test("a signal aborts an in-flight request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      app.get("/api/http/json", { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
