import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { Plugin } from "../../../plugin";
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
    process.env.DATABRICKS_SERVING_ENDPOINT = "test-endpoint";
    ServiceContext.reset();

    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
    delete process.env.DATABRICKS_SERVING_ENDPOINT;
    vi.restoreAllMocks();
  });

  test("serving factory should have correct name", () => {
    const pluginData = serving();
    expect(pluginData.name).toBe("serving");
  });

  test("serving factory with config should have correct name", () => {
    const pluginData = serving({
      endpoints: { llm: { env: "DATABRICKS_SERVING_ENDPOINT" } },
    });
    expect(pluginData.name).toBe("serving");
  });

  describe("default mode", () => {
    test("reads DATABRICKS_SERVING_ENDPOINT", () => {
      const plugin = new ServingPlugin({});
      const exports = plugin.exports() as any;
      expect(exports.invoke).toBeDefined();
      expect(exports.stream).toBeDefined();
    });

    test("injects /invoke and /stream routes", () => {
      const plugin = new ServingPlugin({});
      const { router, handlers } = createMockRouter();

      plugin.injectRoutes(router);

      expect(handlers["POST:/invoke"]).toBeDefined();
      expect(handlers["POST:/stream"]).toBeDefined();
    });

    test("exports returns invoke and stream", () => {
      const plugin = new ServingPlugin({});
      const exports = plugin.exports() as any;

      expect(typeof exports.invoke).toBe("function");
      expect(typeof exports.stream).toBe("function");
      // Should NOT have alias keys in default mode
      expect(exports.llm).toBeUndefined();
    });
  });

  describe("named mode", () => {
    const namedConfig: IServingConfig = {
      endpoints: {
        llm: { env: "DATABRICKS_SERVING_ENDPOINT" },
        embedder: { env: "DATABRICKS_SERVING_ENDPOINT_EMBEDDING" },
      },
    };

    test("injects /:alias/invoke and /:alias/stream routes", () => {
      const plugin = new ServingPlugin(namedConfig);
      const { router, handlers } = createMockRouter();

      plugin.injectRoutes(router);

      expect(handlers["POST:/:alias/invoke"]).toBeDefined();
      expect(handlers["POST:/:alias/stream"]).toBeDefined();
    });

    test("exports returns named endpoints with invoke and stream", () => {
      const plugin = new ServingPlugin(namedConfig);
      const exports = plugin.exports() as any;

      expect(typeof exports.llm.invoke).toBe("function");
      expect(typeof exports.llm.stream).toBe("function");
      expect(typeof exports.embedder.invoke).toBe("function");
      expect(typeof exports.embedder.stream).toBe("function");
    });
  });

  describe("route handlers", () => {
    test("_handleInvoke returns 404 for unknown alias", async () => {
      const plugin = new ServingPlugin({
        endpoints: { llm: { env: "DATABRICKS_SERVING_ENDPOINT" } },
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
        { servedModel: undefined },
      );
      expect(res.json).toHaveBeenCalledWith({ choices: [] });
    });

    test("_handleInvoke returns 404 when env var is not set", async () => {
      delete process.env.DATABRICKS_SERVING_ENDPOINT;

      const plugin = new ServingPlugin({});
      const req = createMockRequest({
        params: { alias: "default" },
        body: { messages: [] },
      });
      const res = createMockResponse();

      await plugin._handleInvoke(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
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
            env: "DATABRICKS_SERVING_ENDPOINT",
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
        { servedModel: undefined },
      );
      expect(result).toEqual({ choices: [{ message: { content: "Hi" } }] });
    });

    test("invoke throws for unknown alias", async () => {
      const plugin = new ServingPlugin({
        endpoints: { llm: { env: "DATABRICKS_SERVING_ENDPOINT" } },
      });

      await expect(plugin.invoke("unknown", { messages: [] })).rejects.toThrow(
        "Unknown endpoint alias: unknown",
      );
    });

    test("stream yields chunks from connector", async () => {
      const chunks = [
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ];

      mockStream.mockImplementation(async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      });

      const plugin = new ServingPlugin({});
      const results: unknown[] = [];
      for await (const chunk of plugin.stream("default", { messages: [] })) {
        results.push(chunk);
      }

      expect(results).toEqual(chunks);
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
