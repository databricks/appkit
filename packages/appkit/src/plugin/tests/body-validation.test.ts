import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  createMockTelemetry,
  mockServiceContext,
} from "@tools/test-helpers";
import type express from "express";
import type { BasePluginConfig, RouteConfig } from "shared";
import {
  afterEach,
  assertType,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { z } from "zod";
import { AppManager } from "../../app";
import { CacheManager } from "../../cache";
import { ServiceContext } from "../../context/service-context";
import { StreamManager } from "../../stream";
import { TelemetryManager, type TelemetryProvider } from "../../telemetry";
import { Plugin } from "../plugin";

vi.mock("../../app");
vi.mock("../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(),
  },
}));
vi.mock("../../stream");
vi.mock("../../telemetry", () => ({
  TelemetryManager: {
    getProvider: vi.fn(),
  },
  normalizeTelemetryOptions: vi.fn((config) => {
    if (typeof config === "boolean") {
      return { traces: config, metrics: config, logs: config };
    }
    return config || { traces: true, metrics: true, logs: true };
  }),
}));

// Silence logger output during validation-failure tests, but expose a
// stable shared mock so individual tests can introspect warn/error
// calls (e.g. the exposeValidationErrors-in-production warning).
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  event: vi.fn(),
}));
vi.mock("../../logging/logger", () => ({
  createLogger: vi.fn(() => loggerMock),
}));

class TestPlugin extends Plugin<BasePluginConfig> {
  // Expose protected route() for testing. Overload signatures mirror the
  // real `route()` so callers get the same TBody inference rules as
  // plugin authors see in production.
  public exposedRoute<TBody>(
    router: express.Router,
    config: Omit<RouteConfig<TBody>, "body"> & { body?: undefined },
  ): void;
  public exposedRoute<TSchema extends StandardSchemaV1<unknown, any>>(
    router: express.Router,
    config: RouteConfig<StandardSchemaV1.InferOutput<TSchema>> & {
      body: TSchema;
    },
  ): void;
  public exposedRoute(
    router: express.Router,
    config:
      | (RouteConfig<any> & { body: StandardSchemaV1<unknown, any> })
      | (Omit<RouteConfig<any>, "body"> & { body?: undefined }),
  ): void {
    // biome-ignore lint/complexity/useLiteralKeys: calling protected member from subclass
    this["route"](router, config as any);
  }
}

function createTestPlugin(): TestPlugin {
  vi.mocked(CacheManager.getInstanceSync).mockReturnValue({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  } as any);
  vi.mocked(AppManager).mockImplementation(() => ({}) as any);
  vi.mocked(StreamManager).mockImplementation(
    () =>
      ({
        stream: vi.fn(),
        abortAll: vi.fn(),
      }) as any,
  );
  vi.mocked(TelemetryManager.getProvider).mockReturnValue(
    createMockTelemetry() as TelemetryProvider,
  );
  return new TestPlugin({ name: "test" });
}

describe("route body validation", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
    process.env.NODE_ENV = originalNodeEnv;
    vi.clearAllMocks();
  });

  test("calls handler and narrows req.body when validation succeeds", async () => {
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({
      content: z.string().min(1),
      conversationId: z.string().optional(),
    });

    const handlerSpy = vi.fn(async (_req: any, res: any) => {
      res.status(200).json({ ok: true });
    });

    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({
      body: { content: "hello", conversationId: "conv-1" },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    // After validation, req.body is the validated (narrowed) value.
    expect(req.body).toEqual({ content: "hello", conversationId: "conv-1" });
  });

  test("returns canonical 400 with issues in development", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Invalid request body",
        code: "VALIDATION_ERROR",
        requestId: expect.any(String),
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.arrayContaining(["content"]),
            message: expect.any(String),
          }),
        ]),
      }),
    );
  });

  test("omits issues in production by default", async () => {
    process.env.NODE_ENV = "production";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const calledWith = (res.json as any).mock.calls[0][0];
    expect(calledWith).toMatchObject({
      error: "Invalid request body",
      code: "VALIDATION_ERROR",
      requestId: expect.any(String),
    });
    expect(calledWith).not.toHaveProperty("issues");
  });

  test("exposes issues in production when exposeValidationErrors=true", async () => {
    process.env.NODE_ENV = "production";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      exposeValidationErrors: true,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Invalid request body",
        code: "VALIDATION_ERROR",
        issues: expect.any(Array),
      }),
    );
  });

  test("prefers x-request-id header for requestId", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: vi.fn(),
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({
      body: {},
      headers: { "x-request-id": "trace-abc-123" },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "trace-abc-123",
      }),
    );
  });

  test("passes the exact handler through when no body schema is provided", async () => {
    const plugin = createTestPlugin();
    const { router } = createMockRouter();

    const postSpy = vi.spyOn(router, "post");

    const handlerRef = vi.fn(async () => {});

    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      handler: handlerRef,
    });

    // Without a body schema, `route()` should register the exact
    // handler reference (no wrapping).
    expect(postSpy).toHaveBeenCalledTimes(1);
    const registered = postSpy.mock.calls[0][1];
    expect(registered).toBe(handlerRef);
  });

  test("supports schemas that return a Promise from ~standard.validate", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const asyncSchema: StandardSchemaV1<unknown, { content: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value) => {
          if (
            typeof value === "object" &&
            value !== null &&
            "content" in value &&
            typeof (value as any).content === "string" &&
            (value as any).content.length > 0
          ) {
            return { value: { content: (value as any).content } };
          }
          return {
            issues: [{ message: "content required", path: ["content"] }],
          };
        },
      },
    };

    const handlerSpy = vi.fn(async (_req, res: any) => {
      res.status(200).json({ ok: true });
    });

    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: asyncSchema,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/messages");
    const goodReq = createMockRequest({ body: { content: "hello" } });
    const goodRes = createMockResponse();
    await handler(goodReq, goodRes);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(goodRes.status).toHaveBeenCalledWith(200);

    const badReq = createMockRequest({ body: {} });
    const badRes = createMockResponse();
    await handler(badReq, badRes);
    expect(badRes.status).toHaveBeenCalledWith(400);
  });

  // Compile-time checks: the overload on `route()` must derive `TBody`
  // from `body`'s schema output when present, and fall back to `unknown`
  // when absent. Plugin authors should never need to write `<TBody>`
  // explicitly — if these blocks type-check without explicit generics,
  // the overload is doing its job.
  test("type-level: handler req.body is narrowed to schema output", () => {
    const plugin = createTestPlugin();
    const { router } = createMockRouter();

    const schema = z.object({
      content: z.string().min(1),
      conversationId: z.string().optional(),
    });

    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: async (req, _res) => {
        // These assertions fail at compile time if the overload regresses.
        assertType<string>(req.body.content);
        assertType<string | undefined>(req.body.conversationId);
      },
    });
  });

  test("type-level: handler req.body defaults to unknown when body is absent", () => {
    const plugin = createTestPlugin();
    const { router } = createMockRouter();

    plugin.exposedRoute(router, {
      name: "noBody",
      method: "post",
      path: "/no-body",
      handler: async (req, _res) => {
        // Without a schema, `req.body` has no compile-time shape. Reading
        // any property off `unknown` is a compile error, so this @ts-expect-error
        // proves the overload falls back to `unknown` (not `any`).
        // @ts-expect-error unknown is not indexable
        req.body.anyProperty;
        assertType<unknown>(req.body);
      },
    });
  });

  test("returns canonical 500 when validator throws synchronously", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    // Zod refinement that throws synchronously.
    const exploding = z.object({
      content: z.string().refine(() => {
        throw new Error("boom from refine");
      }),
    });

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: exploding,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({ body: { content: "anything" } });
    const res = createMockResponse();

    // Should not throw — wrapper must catch and return canonical 500.
    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as any).mock.calls[0][0];
    expect(body).toMatchObject({
      error: "Internal validation error",
      code: "VALIDATION_INTERNAL_ERROR",
      requestId: expect.any(String),
    });
    // Refinement message must not leak to the client.
    expect(JSON.stringify(body)).not.toContain("boom from refine");
  });

  test("returns canonical 500 when async validator rejects", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const rejecting: StandardSchemaV1<unknown, { ok: true }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => {
          throw new Error("async boom");
        },
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: rejecting,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Internal validation error",
        code: "VALIDATION_INTERNAL_ERROR",
        requestId: expect.any(String),
      }),
    );
  });

  test("discards malformed x-request-id and generates a fresh ID", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: vi.fn(),
    });

    const handler = getHandler("POST", "/messages");
    // CRLF injection attempt.
    const evilId = "attacker\r\nSet-Cookie: pwn=1";
    const req = createMockRequest({
      body: {},
      headers: { "x-request-id": evilId },
    });
    const res = createMockResponse();

    await handler(req, res);

    const body = (res.json as any).mock.calls[0][0];
    // Must not reflect the attacker-supplied value.
    expect(body.requestId).not.toBe(evilId);
    expect(body.requestId).not.toContain("\r");
    expect(body.requestId).not.toContain("\n");
    expect(body.requestId).not.toContain("Set-Cookie");
    // Generated fallback has the `req_` prefix.
    expect(body.requestId).toMatch(/^req_[A-Fa-f0-9-]+$/);
  });

  test("discards oversized x-request-id header", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: vi.fn(),
    });

    const handler = getHandler("POST", "/messages");
    // 129 chars — one over the 128-char cap.
    const longId = "a".repeat(129);
    const req = createMockRequest({
      body: {},
      headers: { "x-request-id": longId },
    });
    const res = createMockResponse();

    await handler(req, res);

    const body = (res.json as any).mock.calls[0][0];
    expect(body.requestId).not.toBe(longId);
    expect(body.requestId).toMatch(/^req_[A-Fa-f0-9-]+$/);
  });

  test("accepts x-request-id with dots (unified allowlist)", async () => {
    // Wide-event logger has always allowed dots; the validator wrapper
    // now agrees so operators can grep both wide-events and 4xx
    // responses with the same correlation token.
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: vi.fn(),
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({
      body: {},
      headers: { "x-request-id": "trace.abc-123" },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "trace.abc-123",
      }),
    );
  });

  test("rejects x-request-id starting with a dash", async () => {
    // Leading `-`/`_`/`.` could be misinterpreted as a flag if the
    // requestId ever flows into a shell pipeline an operator runs.
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: vi.fn(),
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({
      body: {},
      headers: { "x-request-id": "--rf" },
    });
    const res = createMockResponse();

    await handler(req, res);

    const body = (res.json as any).mock.calls[0][0];
    expect(body.requestId).not.toBe("--rf");
    expect(body.requestId).toMatch(/^req_[A-Fa-f0-9-]+$/);
  });

  test("rejects x-request-id starting with a dot", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: vi.fn(),
    });

    const handler = getHandler("POST", "/messages");
    const req = createMockRequest({
      body: {},
      headers: { "x-request-id": ".bad" },
    });
    const res = createMockResponse();

    await handler(req, res);

    const body = (res.json as any).mock.calls[0][0];
    expect(body.requestId).not.toBe(".bad");
    expect(body.requestId).toMatch(/^req_[A-Fa-f0-9-]+$/);
  });

  test("generated fallback requestId has 16 hex chars of entropy", async () => {
    // 64-bit entropy keeps birthday collisions astronomically unlikely
    // (~4 billion IDs) while staying short enough to skim in logs.
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const schema = z.object({ content: z.string().min(1) });
    plugin.exposedRoute(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: vi.fn(),
    });

    const handler = getHandler("POST", "/messages");
    // No x-request-id header → wrapper generates the fallback.
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    const body = (res.json as any).mock.calls[0][0];
    // `randomBytes(8).toString("hex")` produces exactly 16 hex chars
    // — no embedded hyphens (the previous `randomUUID().slice(0, 16)`
    // form contained 2 hyphens and only 14 hex chars).
    expect(body.requestId).toMatch(/^req_[a-f0-9]{16}$/);
  });

  test("truncates the issues array to 20 entries and flags issuesTruncated", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    // A schema that always rejects with 50 issues.
    const manyIssues: StandardSchemaV1<unknown, Record<string, never>> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({
          issues: Array.from({ length: 50 }, (_, i) => ({
            message: `issue ${i}`,
            path: [`field${i}`],
          })),
        }),
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "many",
      method: "post",
      path: "/many",
      body: manyIssues,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/many");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.issues).toHaveLength(20);
    expect(body.issuesTruncated).toBe(true);
  });

  test("does not set issuesTruncated when issue count is exactly at limit", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const exactlyTwenty: StandardSchemaV1<unknown, Record<string, never>> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({
          issues: Array.from({ length: 20 }, (_, i) => ({
            message: `issue ${i}`,
            path: [`field${i}`],
          })),
        }),
      },
    };

    plugin.exposedRoute(router, {
      name: "exact",
      method: "post",
      path: "/exact",
      body: exactlyTwenty,
      handler: vi.fn(),
    });

    const handler = getHandler("POST", "/exact");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    const body = (res.json as any).mock.calls[0][0];
    expect(body.issues).toHaveLength(20);
    expect(body).not.toHaveProperty("issuesTruncated");
  });

  test("omits issuesTruncated from response body in production", async () => {
    process.env.NODE_ENV = "production";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const manyIssues: StandardSchemaV1<unknown, Record<string, never>> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({
          issues: Array.from({ length: 50 }, (_, i) => ({
            message: `issue ${i}`,
            path: [`field${i}`],
          })),
        }),
      },
    };

    plugin.exposedRoute(router, {
      name: "many",
      method: "post",
      path: "/many",
      body: manyIssues,
      handler: vi.fn(),
    });

    const handler = getHandler("POST", "/many");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    const body = (res.json as any).mock.calls[0][0];
    // Production hides issues altogether by default.
    expect(body).not.toHaveProperty("issues");
    expect(body).not.toHaveProperty("issuesTruncated");
  });

  test("throws at route registration when body is not a Standard Schema", () => {
    const plugin = createTestPlugin();
    const { router } = createMockRouter();

    expect(() =>
      plugin.exposedRoute(router, {
        name: "bad",
        method: "post",
        path: "/bad",
        // Plugin author accidentally passed a plain object.
        body: { parse: () => {} } as any,
        handler: vi.fn(),
      }),
    ).toThrow(/Standard Schema v1 compliant/);
  });

  // Malformed validator results must not slip into the success path.
  // These tests cover schemas that return shapes outside the Standard
  // Schema discriminated union (neither a clean `{ value }` success nor a
  // `{ issues: [nonEmpty] }` failure). A loose `if (result.issues)` check
  // would misroute these and let `result.value === undefined` reach the
  // handler; the wrapper must fail closed with a canonical 500.
  test("malformed: returns canonical 500 when validator returns { issues: undefined }", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const malformed: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        // Intentionally malformed: `issues` present but undefined, no `value`.
        validate: () => ({ issues: undefined }) as any,
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "bad",
      method: "post",
      path: "/bad",
      body: malformed,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/bad");
    const originalBody = { sentinel: "should-not-be-mutated" };
    const req = createMockRequest({ body: originalBody });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    // req.body must not be mutated into the malformed value.
    expect(req.body).toBe(originalBody);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Internal validation error",
        code: "VALIDATION_INTERNAL_ERROR",
        requestId: expect.any(String),
      }),
    );
  });

  test("malformed: returns canonical 500 when validator returns {}", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const malformed: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        // Intentionally malformed: no `value`, no `issues`.
        validate: () => ({}) as any,
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "bad",
      method: "post",
      path: "/bad",
      body: malformed,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/bad");
    const originalBody = { sentinel: "should-not-be-mutated" };
    const req = createMockRequest({ body: originalBody });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(req.body).toBe(originalBody);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Internal validation error",
        code: "VALIDATION_INTERNAL_ERROR",
        requestId: expect.any(String),
      }),
    );
  });

  // Regression: `{ value, issues: <non-array> }` is a malformed shape
  // (the spec requires `issues` to be a `ReadonlyArray<Issue>`). The
  // earlier 400 gate only fires when `Array.isArray(issues)` is true,
  // so without the tightened 500 gate this result would slip through
  // to the success path with a possibly-invalid `value`. Both cases
  // (string `issues`, `undefined` `issues`) must route to 500.
  test("malformed: returns canonical 500 when validator returns { value, issues: 'string' }", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const malformed: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () =>
          ({ value: { ok: true }, issues: "not-an-array" }) as any,
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "bad",
      method: "post",
      path: "/bad",
      body: malformed,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/bad");
    const originalBody = { sentinel: "should-not-be-mutated" };
    const req = createMockRequest({ body: originalBody });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(req.body).toBe(originalBody);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Internal validation error",
        code: "VALIDATION_INTERNAL_ERROR",
        requestId: expect.any(String),
      }),
    );
  });

  test("malformed: returns canonical 500 when validator returns { value, issues: undefined }", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const malformed: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ value: { ok: true }, issues: undefined }) as any,
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "bad",
      method: "post",
      path: "/bad",
      body: malformed,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/bad");
    const originalBody = { sentinel: "should-not-be-mutated" };
    const req = createMockRequest({ body: originalBody });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(req.body).toBe(originalBody);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Internal validation error",
        code: "VALIDATION_INTERNAL_ERROR",
      }),
    );
  });

  test("empty issues array routes to canonical 400 (any array-valued issues = failure)", async () => {
    // Standard Schema v1's `FailureResult` is defined as
    // `{ readonly issues: ReadonlyArray<Issue> }` with no minimum
    // cardinality, so any array-valued `issues` field — including an
    // empty array — is a failure shape. The handler must NOT run; the
    // wrapper emits a canonical 400 with `issues: []` in the response
    // body in development / override mode.
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const emptyIssues: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [] }) as any,
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "good",
      method: "post",
      path: "/good",
      body: emptyIssues,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/good");
    const originalBody = { any: "thing" };
    const req = createMockRequest({ body: originalBody });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    // req.body must not be mutated when validation fails.
    expect(req.body).toBe(originalBody);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as any).mock.calls[0][0];
    expect(body).toMatchObject({
      error: "Invalid request body",
      code: "VALIDATION_ERROR",
      requestId: expect.any(String),
    });
    // Empty issues array is reflected in the response body in dev mode.
    expect(body.issues).toEqual([]);
    expect(body).not.toHaveProperty("issuesTruncated");
  });

  test("empty issues array in production omits issues from response", async () => {
    // Production hides issues by default regardless of count.
    process.env.NODE_ENV = "production";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const emptyIssues: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [] }) as any,
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "good",
      method: "post",
      path: "/good",
      body: emptyIssues,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/good");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as any).mock.calls[0][0];
    expect(body).toMatchObject({
      error: "Invalid request body",
      code: "VALIDATION_ERROR",
      requestId: expect.any(String),
    });
    expect(body).not.toHaveProperty("issues");
  });

  test("mixed shape { value, issues: [] } routes to validation failure", async () => {
    // Per the strict spec reading, the discriminator is the presence
    // of an array-valued `issues` field — not its length, and not the
    // absence of `value`. A validator that returns both `value` and an
    // array `issues` is buggy; we route it to failure (not success) so
    // the handler never sees a possibly-invalid body.
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const mixed: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ value: { any: "thing" }, issues: [] }) as any,
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "mixed",
      method: "post",
      path: "/mixed",
      body: mixed,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/mixed");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Invalid request body",
        code: "VALIDATION_ERROR",
      }),
    );
  });

  test("non-empty issues array is a validation failure (canonical 400)", async () => {
    process.env.NODE_ENV = "development";
    const plugin = createTestPlugin();
    const { router, getHandler } = createMockRouter();

    const failing: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({
          issues: [{ message: "nope", path: ["field"] }],
        }),
      },
    };

    const handlerSpy = vi.fn();

    plugin.exposedRoute(router, {
      name: "fail",
      method: "post",
      path: "/fail",
      body: failing,
      handler: handlerSpy,
    });

    const handler = getHandler("POST", "/fail");
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handler(req, res);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Invalid request body",
        code: "VALIDATION_ERROR",
      }),
    );
  });

  // Item 3: route() must surface a one-time warning at registration time
  // when a route opts in to exposing schema details to anonymous callers
  // in production. Body validation runs BEFORE plugin-level
  // authentication, so the 400 payload is reachable by any client.
  describe("exposeValidationErrors production warning", () => {
    test("warns at route registration when exposeValidationErrors=true in production", () => {
      process.env.NODE_ENV = "production";
      const plugin = createTestPlugin();
      const { router } = createMockRouter();
      loggerMock.warn.mockClear();

      const schema = z.object({ content: z.string().min(1) });
      plugin.exposedRoute(router, {
        name: "public",
        method: "post",
        path: "/public",
        body: schema,
        exposeValidationErrors: true,
        handler: vi.fn(),
      });

      expect(loggerMock.warn).toHaveBeenCalledTimes(1);
      const [message, context] = loggerMock.warn.mock.calls[0];
      expect(message).toMatch(/exposeValidationErrors/i);
      expect(message).toMatch(/production/i);
      expect(message).toMatch(/before plugin-level/i);
      expect(context).toEqual(
        expect.objectContaining({
          method: "post",
          path: "/public",
          plugin: "test",
        }),
      );
    });

    test("does not warn when exposeValidationErrors is undefined", () => {
      process.env.NODE_ENV = "production";
      const plugin = createTestPlugin();
      const { router } = createMockRouter();
      loggerMock.warn.mockClear();

      const schema = z.object({ content: z.string().min(1) });
      plugin.exposedRoute(router, {
        name: "internal",
        method: "post",
        path: "/internal",
        body: schema,
        handler: vi.fn(),
      });

      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    test("does not warn when exposeValidationErrors=false in production", () => {
      process.env.NODE_ENV = "production";
      const plugin = createTestPlugin();
      const { router } = createMockRouter();
      loggerMock.warn.mockClear();

      const schema = z.object({ content: z.string().min(1) });
      plugin.exposedRoute(router, {
        name: "internal",
        method: "post",
        path: "/internal",
        body: schema,
        exposeValidationErrors: false,
        handler: vi.fn(),
      });

      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    test("does not warn when NODE_ENV is development", () => {
      process.env.NODE_ENV = "development";
      const plugin = createTestPlugin();
      const { router } = createMockRouter();
      loggerMock.warn.mockClear();

      const schema = z.object({ content: z.string().min(1) });
      plugin.exposedRoute(router, {
        name: "public",
        method: "post",
        path: "/public",
        body: schema,
        exposeValidationErrors: true,
        handler: vi.fn(),
      });

      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    test("does not warn when NODE_ENV is test", () => {
      process.env.NODE_ENV = "test";
      const plugin = createTestPlugin();
      const { router } = createMockRouter();
      loggerMock.warn.mockClear();

      const schema = z.object({ content: z.string().min(1) });
      plugin.exposedRoute(router, {
        name: "public",
        method: "post",
        path: "/public",
        body: schema,
        exposeValidationErrors: true,
        handler: vi.fn(),
      });

      expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    test("does not warn when route has no body schema", () => {
      process.env.NODE_ENV = "production";
      const plugin = createTestPlugin();
      const { router } = createMockRouter();
      loggerMock.warn.mockClear();

      // exposeValidationErrors is meaningless without a body schema, but
      // even if a plugin author sets it, no warning fires because the
      // wrapper is never attached.
      plugin.exposedRoute(router, {
        name: "noBody",
        method: "post",
        path: "/no-body",
        handler: vi.fn(),
      });

      expect(loggerMock.warn).not.toHaveBeenCalled();
    });
  });

  // Item 4: the validation wrapper consults the same correlation
  // headers as the wide-event logger (in the same order) so the
  // canonical 4xx requestId matches the wide-event log's request_id.
  describe("requestId header precedence (shared resolver)", () => {
    test("falls back to x-amzn-trace-id when x-request-id is absent", async () => {
      // Without the shared resolver, the validation wrapper only saw
      // x-request-id while the wide-event logger reads x-amzn-trace-id
      // — operators got two different IDs for the same request and
      // could not correlate.
      process.env.NODE_ENV = "development";
      const plugin = createTestPlugin();
      const { router, getHandler } = createMockRouter();

      const schema = z.object({ content: z.string().min(1) });
      plugin.exposedRoute(router, {
        name: "sendMessage",
        method: "post",
        path: "/messages",
        body: schema,
        handler: vi.fn(),
      });

      const handler = getHandler("POST", "/messages");
      const req = createMockRequest({
        body: {},
        headers: { "x-amzn-trace-id": "Root.1-abc-def" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "Root.1-abc-def",
        }),
      );
    });

    test("falls back to x-correlation-id when x-request-id is absent", async () => {
      process.env.NODE_ENV = "development";
      const plugin = createTestPlugin();
      const { router, getHandler } = createMockRouter();

      const schema = z.object({ content: z.string().min(1) });
      plugin.exposedRoute(router, {
        name: "sendMessage",
        method: "post",
        path: "/messages",
        body: schema,
        handler: vi.fn(),
      });

      const handler = getHandler("POST", "/messages");
      const req = createMockRequest({
        body: {},
        headers: { "x-correlation-id": "corr-abc-123" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "corr-abc-123",
        }),
      );
    });

    test("prefers x-request-id over later headers", async () => {
      process.env.NODE_ENV = "development";
      const plugin = createTestPlugin();
      const { router, getHandler } = createMockRouter();

      const schema = z.object({ content: z.string().min(1) });
      plugin.exposedRoute(router, {
        name: "sendMessage",
        method: "post",
        path: "/messages",
        body: schema,
        handler: vi.fn(),
      });

      const handler = getHandler("POST", "/messages");
      const req = createMockRequest({
        body: {},
        headers: {
          "x-request-id": "primary-id",
          "x-correlation-id": "secondary-id",
          "x-amzn-trace-id": "tertiary-id",
        },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "primary-id",
        }),
      );
    });

    test("skips a malformed earlier header and uses a valid later one", async () => {
      process.env.NODE_ENV = "development";
      const plugin = createTestPlugin();
      const { router, getHandler } = createMockRouter();

      const schema = z.object({ content: z.string().min(1) });
      plugin.exposedRoute(router, {
        name: "sendMessage",
        method: "post",
        path: "/messages",
        body: schema,
        handler: vi.fn(),
      });

      const handler = getHandler("POST", "/messages");
      const req = createMockRequest({
        body: {},
        headers: {
          // Malformed: starts with a dash (rejected by sanitizer).
          "x-request-id": "-rf",
          "x-correlation-id": "fallback-ok",
        },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "fallback-ok",
        }),
      );
    });
  });
});
