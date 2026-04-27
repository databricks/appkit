import { PassThrough } from "node:stream";
import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { ServingPlugin, serving } from "../serving";
import type { IServingConfig } from "../types";

// Mock CacheManager singleton
const { mockCacheInstance } = vi.hoisted(() => {
  const instance = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi
      .fn()
      .mockImplementation(
        async (_key: unknown[], fn: () => Promise<unknown>) => {
          return await fn();
        },
      ),
    generateKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  };
  return { mockCacheInstance: instance };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

// Mock the serving connector
const mockInvoke = vi.fn();
const mockStream = vi.fn();

vi.mock("../../../connectors/serving/client", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  stream: (...args: any[]) => mockStream(...args),
}));

describe("Serving Plugin", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    setupDatabricksEnv();
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = "test-endpoint";
    ServiceContext.reset();

    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
    delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    vi.restoreAllMocks();
  });

  test("serving factory should have correct name", () => {
    const pluginData = serving();
    expect(pluginData.name).toBe("serving");
  });

  test("serving factory with config should have correct name", () => {
    const pluginData = serving({
      endpoints: { llm: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } },
    });
    expect(pluginData.name).toBe("serving");
  });

  describe("default mode", () => {
    test("reads DATABRICKS_SERVING_ENDPOINT_NAME", () => {
      const plugin = new ServingPlugin({});
      const api = (plugin.exports() as any)();
      expect(api.invoke).toBeDefined();
    });

    test("injects /invoke and /stream routes", () => {
      const plugin = new ServingPlugin({});
      const { router, handlers } = createMockRouter();

      plugin.injectRoutes(router);

      expect(handlers["POST:/invoke"]).toBeDefined();
      expect(handlers["POST:/stream"]).toBeDefined();
    });

    test("also registers /:alias/invoke and /:alias/stream for type-generated clients", () => {
      const plugin = new ServingPlugin({});
      const { router, handlers } = createMockRouter();

      plugin.injectRoutes(router);

      expect(handlers["POST:/:alias/invoke"]).toBeDefined();
      expect(handlers["POST:/:alias/stream"]).toBeDefined();
    });

    test("exports returns a factory that provides invoke", () => {
      const plugin = new ServingPlugin({});
      const factory = plugin.exports() as any;
      const api = factory();

      expect(typeof api.invoke).toBe("function");
    });
  });

  describe("named mode", () => {
    const namedConfig: IServingConfig = {
      endpoints: {
        llm: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
        embedder: { env: "DATABRICKS_SERVING_ENDPOINT_NAME_EMBEDDING" },
      },
    };

    test("injects /:alias/invoke and /:alias/stream routes", () => {
      const plugin = new ServingPlugin(namedConfig);
      const { router, handlers } = createMockRouter();

      plugin.injectRoutes(router);

      expect(handlers["POST:/:alias/invoke"]).toBeDefined();
      expect(handlers["POST:/:alias/stream"]).toBeDefined();
    });

    test("exports factory returns invoke for named aliases", () => {
      const plugin = new ServingPlugin(namedConfig);
      const factory = plugin.exports() as any;

      expect(typeof factory("llm").invoke).toBe("function");
      expect(typeof factory("embedder").invoke).toBe("function");
    });
  });

  describe("route handlers", () => {
    test("_handleInvoke returns 404 for unknown alias", async () => {
      const plugin = new ServingPlugin({
        endpoints: { llm: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } },
      });

      const req = createMockRequest({
        params: { alias: "unknown" },
        body: { messages: [] },
      });
      const res = createMockResponse();

      await plugin._handleInvoke(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unknown endpoint alias: unknown",
      });
    });

    test("_handleInvoke calls connector with correct endpoint", async () => {
      mockInvoke.mockResolvedValue({ choices: [] });

      const plugin = new ServingPlugin({});
      const req = createMockRequest({
        params: { alias: "default" },
        body: { messages: [{ role: "user", content: "Hello" }] },
      });
      const res = createMockResponse();

      await plugin._handleInvoke(req as any, res as any);

      expect(mockInvoke).toHaveBeenCalledWith(
        expect.anything(),
        "test-endpoint",
        { messages: [{ role: "user", content: "Hello" }] },
      );
      expect(res.json).toHaveBeenCalledWith({ choices: [] });
    });

    test("_handleInvoke returns 400 with descriptive message when env var is not set", async () => {
      delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

      const plugin = new ServingPlugin({});
      const req = createMockRequest({
        params: { alias: "default" },
        body: { messages: [] },
      });
      const res = createMockResponse();

      await plugin._handleInvoke(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error:
          "Endpoint 'default' is not configured: env var 'DATABRICKS_SERVING_ENDPOINT_NAME' is not set",
      });
    });

    test("_handleInvoke does not throw when connector fails", async () => {
      mockInvoke.mockRejectedValue(new Error("Connection refused"));

      const plugin = new ServingPlugin({});
      const req = createMockRequest({
        params: { alias: "default" },
        body: { messages: [] },
      });
      const res = createMockResponse();

      // Should not throw — execute() handles the error internally
      await expect(
        plugin._handleInvoke(req as any, res as any),
      ).resolves.not.toThrow();
    });

    test("_handleStream returns 404 for unknown alias", async () => {
      const plugin = new ServingPlugin({
        endpoints: { llm: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } },
      });

      const req = createMockRequest({
        params: { alias: "unknown" },
        body: { messages: [] },
        query: {},
      });
      const res = createMockResponse();

      await plugin._handleStream(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unknown endpoint alias: unknown",
      });
    });

    test("_handleStream returns 400 when env var is not set", async () => {
      delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

      const plugin = new ServingPlugin({});
      const req = createMockRequest({
        params: { alias: "default" },
        body: { messages: [] },
        query: {},
      });
      const res = createMockResponse();

      await plugin._handleStream(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error:
          "Endpoint 'default' is not configured: env var 'DATABRICKS_SERVING_ENDPOINT_NAME' is not set",
      });
    });

    test("_handleStream pipes raw SSE bytes to response", async () => {
      const ssePayload =
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
      const encoder = new TextEncoder();
      const rawStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(ssePayload));
          controller.close();
        },
      });
      mockStream.mockResolvedValue(rawStream);

      const plugin = new ServingPlugin({});
      const req = createMockRequest({
        params: { alias: "default" },
        body: { messages: [{ role: "user", content: "Hello" }] },
        query: {},
      });
      // Add req.on for client disconnect handling
      req.on = vi.fn();

      // Use a real writable stream so pipeline() works
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk));

      const res = Object.assign(output, {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
      });

      await plugin._handleStream(req as any, res as any);

      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream",
      );
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
      expect(mockStream).toHaveBeenCalledWith(
        expect.anything(),
        "test-endpoint",
        { messages: [{ role: "user", content: "Hello" }] },
      );
      const written = Buffer.concat(chunks).toString();
      expect(written).toBe(ssePayload);
    });

    test("_handleStream returns 502 when stream fails", async () => {
      mockStream.mockRejectedValue(new Error("Connection refused"));

      const plugin = new ServingPlugin({});
      const req = createMockRequest({
        params: { alias: "default" },
        body: { messages: [] },
        query: {},
      });
      const res = createMockResponse();

      await plugin._handleStream(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({ error: "Connection refused" });
    });
  });

  describe("getResourceRequirements", () => {
    test("generates requirements for default mode", () => {
      const reqs = ServingPlugin.getResourceRequirements({});
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({
        type: "serving_endpoint",
        alias: "serving-default",
        permission: "CAN_QUERY",
        fields: {
          name: {
            env: "DATABRICKS_SERVING_ENDPOINT_NAME",
          },
        },
      });
    });

    test("generates requirements for named mode", () => {
      const reqs = ServingPlugin.getResourceRequirements({
        endpoints: {
          llm: { env: "LLM_ENDPOINT" },
          embedder: { env: "EMBED_ENDPOINT" },
        },
      });
      expect(reqs).toHaveLength(2);
      expect(reqs[0].fields.name.env).toBe("LLM_ENDPOINT");
      expect(reqs[1].fields.name.env).toBe("EMBED_ENDPOINT");
    });
  });

  describe("programmatic API", () => {
    test("invoke calls connector correctly", async () => {
      mockInvoke.mockResolvedValue({
        choices: [{ message: { content: "Hi" } }],
      });

      const plugin = new ServingPlugin({});
      const result = await plugin.invoke("default", { messages: [] });

      expect(mockInvoke).toHaveBeenCalledWith(
        expect.anything(),
        "test-endpoint",
        { messages: [] },
      );
      expect(result).toEqual({
        ok: true,
        data: { choices: [{ message: { content: "Hi" } }] },
      });
    });

    test("invoke throws for unknown alias", async () => {
      const plugin = new ServingPlugin({
        endpoints: { llm: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } },
      });

      await expect(plugin.invoke("unknown", { messages: [] })).rejects.toThrow(
        "Unknown endpoint alias: unknown",
      );
    });
  });

  describe("shutdown", () => {
    test("calls streamManager.abortAll", async () => {
      const plugin = new ServingPlugin({});
      // Accessing the protected streamManager through the plugin
      const abortSpy = vi.spyOn((plugin as any).streamManager, "abortAll");

      await plugin.shutdown();

      expect(abortSpy).toHaveBeenCalled();
    });
  });
});
