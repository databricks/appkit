import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  createMockTelemetry,
  mockServiceContext,
} from "@tools/test-helpers";
import type express from "express";
import type { BasePluginConfig } from "shared";
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

// Silence logger output during validation-failure tests.
vi.mock("../../logging/logger", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: vi.fn(),
  })),
}));

class TestPlugin extends Plugin<BasePluginConfig> {
  // Expose protected route() for testing.
  public exposedRoute<TBody>(
    router: express.Router,
    config: Parameters<typeof this.route<TBody>>[1],
  ) {
    // biome-ignore lint/complexity/useLiteralKeys: calling protected member from subclass
    return this["route"]<TBody>(router, config);
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

    plugin.exposedRoute<z.infer<typeof schema>>(router, {
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

    plugin.exposedRoute<z.infer<typeof schema>>(router, {
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

    plugin.exposedRoute<z.infer<typeof schema>>(router, {
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

    plugin.exposedRoute<z.infer<typeof schema>>(router, {
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
    plugin.exposedRoute<z.infer<typeof schema>>(router, {
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

    plugin.exposedRoute<{ content: string }>(router, {
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

  // Compile-time check: handler's req.body should be typed as the schema's
  // output. If this block type-checks, the generic is threading through.
  test("type-level: handler req.body is narrowed to schema output", () => {
    const plugin = createTestPlugin();
    const { router } = createMockRouter();

    const schema = z.object({
      content: z.string().min(1),
      conversationId: z.string().optional(),
    });
    type Body = z.infer<typeof schema>;

    plugin.exposedRoute<Body>(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      body: schema,
      handler: async (req, _res) => {
        // These assertions fail at compile time if generics regress.
        assertType<string>(req.body.content);
        assertType<string | undefined>(req.body.conversationId);
      },
    });
  });
});
