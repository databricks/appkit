import {
  type ContextManager,
  createContextKey,
  context as otelContext,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createMockTelemetry, mockServiceContext } from "@tools/test-helpers";
import type express from "express";
import type {
  BasePluginConfig,
  IAppResponse,
  PluginExecuteConfig,
} from "shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { AppManager } from "../../app";
import { CacheManager } from "../../cache";
import { ServiceContext } from "../../context/service-context";
import {
  AuthenticationError,
  ConnectionError,
  ExecutionError,
  TunnelError,
  ValidationError,
} from "../../errors";
import { StreamManager } from "../../stream";
import type { ITelemetry, TelemetryProvider } from "../../telemetry";
import { TelemetryManager } from "../../telemetry";
import type { InterceptorContext } from "../interceptors/types";
import { isDevOboFallback, Plugin } from "../plugin";

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "ApiError";
      this.statusCode = statusCode;
    }
  }
  return { MockApiError };
});

vi.mock("@databricks/sdk-experimental", () => ({
  ApiError: MockApiError,
}));

// Mock all dependencies
vi.mock("../../app");
vi.mock("../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(),
  },
}));
vi.mock("../../stream");
vi.mock("../../utils", () => ({
  deepMerge: vi.fn((a, b) => {
    if (!a) return b;
    if (!b) return a;

    const result = { ...a };
    for (const key in b) {
      if (
        typeof b[key] === "object" &&
        b[key] !== null &&
        !Array.isArray(b[key])
      ) {
        result[key] =
          typeof a[key] === "object" ? { ...a[key], ...b[key] } : b[key];
      } else {
        result[key] = b[key];
      }
    }
    return result;
  }),
}));
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

// Mock interceptors
vi.mock("../interceptors/cache", () => ({
  CacheInterceptor: vi.fn().mockImplementation((_cache, _config) => ({
    intercept: vi.fn().mockImplementation((fn, _context) => fn()),
  })),
}));

vi.mock("../interceptors/retry", () => ({
  RetryInterceptor: vi.fn().mockImplementation((_config) => ({
    intercept: vi.fn().mockImplementation((fn, _context) => fn()),
  })),
}));

vi.mock("../interceptors/timeout", () => ({
  TimeoutInterceptor: vi.fn().mockImplementation((_timeout) => ({
    intercept: vi.fn().mockImplementation((fn, _context) => fn()),
  })),
}));

vi.mock("../interceptors/telemetry", () => ({
  TelemetryInterceptor: vi.fn().mockImplementation((_telemetry, _config) => ({
    intercept: vi.fn().mockImplementation((fn, _context) => fn()),
  })),
}));

// Test plugin implementations
class TestPlugin extends Plugin<BasePluginConfig> {
  async customMethod(value: string): Promise<string> {
    return `processed-${value}`;
  }

  syncMethod(value: string): string {
    return `sync-${value}`;
  }

  methodThatThrows(): string {
    throw new Error("Method error");
  }

  async asyncMethodThatThrows(): Promise<string> {
    throw new Error("Async method error");
  }

  exports() {
    return {
      customMethod: this.customMethod,
      syncMethod: this.syncMethod,
    };
  }
}

class PluginWithCustomSetup extends TestPlugin {
  setupCalled = false;

  async setup() {
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.setupCalled = true;
  }
}

class PluginWithRoutes extends TestPlugin {
  routesInjected = false;

  injectRoutes(_router: express.Router) {
    this.routesInjected = true;
    // Mock route injection
  }
}

class OboTestPlugin extends Plugin<BasePluginConfig> {
  lastOboFallbackValue: boolean | undefined;

  async captureOboFallback(): Promise<string> {
    this.lastOboFallbackValue = isDevOboFallback();
    return "captured";
  }

  syncCapture(): string {
    this.lastOboFallbackValue = isDevOboFallback();
    return "sync-captured";
  }
}

describe("Plugin", () => {
  let mockTelemetry: ITelemetry;
  let mockCache: CacheManager;
  let mockApp: AppManager;
  let mockStreamManager: StreamManager;
  let config: BasePluginConfig;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    vi.useFakeTimers();

    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    mockTelemetry = createMockTelemetry();

    mockCache = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    } as any;

    mockApp = {
      getAppQuery: vi.fn(),
    } as any;

    mockStreamManager = {
      stream: vi.fn(),
      abortAll: vi.fn(),
    } as any;

    config = {
      name: "test-plugin",
      timeout: 5000,
      cache: { enabled: true, cacheKey: ["test"] },
      retry: { enabled: true, attempts: 3 },
    };

    // Setup constructor mocks
    vi.mocked(CacheManager.getInstanceSync).mockReturnValue(mockCache);
    vi.mocked(AppManager).mockImplementation(() => mockApp);
    vi.mocked(StreamManager).mockImplementation(() => mockStreamManager);
    vi.mocked(TelemetryManager.getProvider).mockReturnValue(
      mockTelemetry as TelemetryProvider,
    );

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    serviceContextMock?.restore();
  });

  describe("constructor", () => {
    test("should initialize with provided config", () => {
      const plugin = new TestPlugin(config);

      expect(plugin.name).toBe("test-plugin");
      // @ts-expect-error - isReady is protected
      expect(plugin.isReady).toBe(true);
    });

    test("should use default name when not provided in config", () => {
      const configWithoutName = { ...config, name: undefined };
      const plugin = new TestPlugin(configWithoutName);

      expect(plugin.name).toBe("plugin");
    });

    test("should initialize managers", () => {
      new TestPlugin(config);

      expect(CacheManager.getInstanceSync).toHaveBeenCalledTimes(1);
      expect(AppManager).toHaveBeenCalledTimes(1);
      expect(StreamManager).toHaveBeenCalledTimes(1);
    });
  });

  describe("setup", () => {
    test("should have empty default setup", async () => {
      const plugin = new TestPlugin(config);

      await expect(plugin.setup()).resolves.toBeUndefined();
    });

    test("should allow custom setup implementation", async () => {
      vi.useRealTimers(); // Use real timers for this test

      const plugin = new PluginWithCustomSetup(config);

      await plugin.setup();

      expect(plugin.setupCalled).toBe(true);

      vi.useFakeTimers(); // Restore fake timers
    });
  });

  describe("injectRoutes", () => {
    test("should have empty default implementation", () => {
      const plugin = new TestPlugin(config);
      const mockRouter = {} as express.Router;

      expect(() => plugin.injectRoutes(mockRouter)).not.toThrow();
    });

    test("should allow custom route injection", () => {
      const plugin = new PluginWithRoutes(config);
      const mockRouter = {} as express.Router;

      plugin.injectRoutes(mockRouter);

      expect(plugin.routesInjected).toBe(true);
    });
  });

  describe("abortActiveOperations", () => {
    test("should call streamManager.abortAll", () => {
      const plugin = new TestPlugin(config);

      plugin.abortActiveOperations();

      expect(mockStreamManager.abortAll).toHaveBeenCalledTimes(1);
    });
  });

  describe("executeStream", () => {
    test("should call streamManager.stream with correct parameters", async () => {
      const plugin = new TestPlugin(config);
      const mockResponse = {} as IAppResponse;
      const mockFn = vi.fn().mockResolvedValue("result");

      const options = {
        default: { timeout: 1000 },
        user: { timeout: 2000 },
        stream: {},
      };

      await (plugin as any).executeStream(mockResponse, mockFn, options, false);

      expect(mockStreamManager.stream).toHaveBeenCalledTimes(1);
      expect(mockStreamManager.stream).toHaveBeenCalledWith(
        mockResponse,
        expect.any(Function),
        {},
      );
    });

    test("should build execution options correctly", async () => {
      const plugin = new TestPlugin(config);
      const mockResponse = {} as IAppResponse;
      const mockFn = vi.fn().mockResolvedValue("result");

      // Mock streamManager to capture the generator function
      let _capturedGenerator: any;
      vi.mocked(mockStreamManager.stream).mockImplementation(
        async (_res, genFn) => {
          _capturedGenerator = genFn;
        },
      );

      const options = {
        default: { timeout: 1000, cache: { enabled: false } },
        user: { timeout: 2000 },
        stream: {},
      };

      await (plugin as any).executeStream(mockResponse, mockFn, options, false);

      expect(mockStreamManager.stream).toHaveBeenCalled();
    });
  });

  describe("execute", () => {
    test("should return ok result on success", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi.fn().mockResolvedValue("result");

      const options = {
        default: { timeout: 1000 },
        user: { timeout: 2000 },
      };

      const result = await (plugin as any).execute(mockFn, options, false);

      expect(result).toEqual({ ok: true, data: "result" });
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test("should return error result with status 500 for non-AppKitError in production", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        const plugin = new TestPlugin(config);
        const mockFn = vi.fn().mockRejectedValue(new Error("secret details"));

        const result = await (plugin as any).execute(
          mockFn,
          { default: {} },
          false,
        );

        expect(result).toEqual({
          ok: false,
          status: 500,
          message: "Server error",
        });
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test("should return original message for non-AppKitError in development", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        const plugin = new TestPlugin(config);
        const mockFn = vi
          .fn()
          .mockRejectedValue(new Error("detailed debug info"));

        const result = await (plugin as any).execute(
          mockFn,
          { default: {} },
          false,
        );

        expect(result).toEqual({
          ok: false,
          status: 500,
          message: "detailed debug info",
        });
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test("should preserve 404 statusCode from ApiError (non-AppKitError)", async () => {
      const plugin = new TestPlugin(config);
      const apiError = new MockApiError("Not found", 404);
      const mockFn = vi.fn().mockRejectedValue(apiError);

      const result = await (plugin as any).execute(
        mockFn,
        { default: {} },
        false,
      );
      expect(result).toEqual({
        ok: false,
        status: 404,
        message: "Not found",
      });
    });

    test("should preserve 401 statusCode from ApiError (non-AppKitError)", async () => {
      const plugin = new TestPlugin(config);
      const apiError = new MockApiError("Unauthorized", 401);
      const mockFn = vi.fn().mockRejectedValue(apiError);

      const result = await (plugin as any).execute(
        mockFn,
        { default: {} },
        false,
      );
      expect(result).toEqual({
        ok: false,
        status: 401,
        message: "Unauthorized",
      });
    });

    test("should preserve 403 statusCode from ApiError (non-AppKitError)", async () => {
      const plugin = new TestPlugin(config);
      const apiError = new MockApiError("Forbidden", 403);
      const mockFn = vi.fn().mockRejectedValue(apiError);

      const result = await (plugin as any).execute(
        mockFn,
        { default: {} },
        false,
      );
      expect(result).toEqual({
        ok: false,
        status: 403,
        message: "Forbidden",
      });
    });

    test("should preserve 502 statusCode from non-AppKitError", async () => {
      const plugin = new TestPlugin(config);
      const apiError = new MockApiError("Bad gateway", 502);
      const mockFn = vi.fn().mockRejectedValue(apiError);

      const result = await (plugin as any).execute(
        mockFn,
        { default: {} },
        false,
      );
      expect(result).toEqual({
        ok: false,
        status: 502,
        message: "Bad gateway",
      });
    });

    test("should redact message for 5xx statusCode errors in production", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        const plugin = new TestPlugin(config);
        const apiError = new MockApiError("Internal upstream detail", 502);
        const mockFn = vi.fn().mockRejectedValue(apiError);

        const result = await (plugin as any).execute(
          mockFn,
          { default: {} },
          false,
        );
        expect(result).toEqual({
          ok: false,
          status: 502,
          message: "Server error",
        });
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test("should preserve message for 4xx statusCode errors in production", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        const plugin = new TestPlugin(config);
        const apiError = new MockApiError("Forbidden", 403);
        const mockFn = vi.fn().mockRejectedValue(apiError);

        const result = await (plugin as any).execute(
          mockFn,
          { default: {} },
          false,
        );
        expect(result).toEqual({
          ok: false,
          status: 403,
          message: "Forbidden",
        });
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test("should map AuthenticationError to status 401", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi
        .fn()
        .mockRejectedValue(AuthenticationError.missingToken());

      const result = await (plugin as any).execute(
        mockFn,
        { default: {} },
        false,
      );
      expect(result).toEqual({
        ok: false,
        status: 401,
        message: expect.any(String),
      });
    });

    test("should map ValidationError to status 400", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi
        .fn()
        .mockRejectedValue(new ValidationError("bad input"));

      const result = await (plugin as any).execute(
        mockFn,
        { default: {} },
        false,
      );
      expect(result).toEqual({ ok: false, status: 400, message: "bad input" });
    });

    test("should map ConnectionError to status 503", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi
        .fn()
        .mockRejectedValue(ConnectionError.apiFailure("test-service"));

      const result = await (plugin as any).execute(
        mockFn,
        { default: {} },
        false,
      );
      expect(result).toEqual({
        ok: false,
        status: 503,
        message: expect.any(String),
      });
    });

    test("should map TunnelError to status 502", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi
        .fn()
        .mockRejectedValue(new TunnelError("gateway failed"));

      const result = await (plugin as any).execute(
        mockFn,
        { default: {} },
        false,
      );
      expect(result).toEqual({
        ok: false,
        status: 502,
        message: "gateway failed",
      });
    });

    test("should map ExecutionError to status 500", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi
        .fn()
        .mockRejectedValue(ExecutionError.statementFailed("query broke"));

      const result = await (plugin as any).execute(
        mockFn,
        { default: {} },
        false,
      );
      expect(result).toEqual({
        ok: false,
        status: 500,
        message: expect.any(String),
      });
    });
  });

  describe("_buildExecutionConfig", () => {
    test("should merge options in correct priority order", () => {
      const plugin = new TestPlugin({
        name: "test",
        timeout: 3000,
        cache: { enabled: true },
      });

      const methodDefaults = { timeout: 1000, retry: { attempts: 2 } };
      const userOverride = { timeout: 5000 };

      // @ts-expect-error - _buildExecutionConfig is private
      const result = plugin._buildExecutionConfig({
        default: methodDefaults,
        user: userOverride,
      });

      // User override should win for timeout
      expect(result.timeout).toBe(5000);
      // Plugin config should be included
      expect(result.cache?.enabled).toBe(true);
      // Method defaults should be included when not overridden
      expect(result.retry?.attempts).toBe(2);
    });

    test("should handle undefined user overrides", () => {
      const plugin = new TestPlugin({ name: "test", timeout: 2000 });

      const methodDefaults = { timeout: 1000 };

      // @ts-expect-error - _buildExecutionConfig is private
      const result = plugin._buildExecutionConfig({
        default: methodDefaults,
      });

      expect(result.timeout).toBe(2000); // Plugin config wins
    });
  });

  describe("_buildInterceptors", () => {
    test("should build interceptors in correct order", async () => {
      const plugin = new TestPlugin(config);

      const options: PluginExecuteConfig = {
        timeout: 5000,
        retry: { enabled: true, attempts: 3 },
        cache: { enabled: true, cacheKey: ["test"] },
      };
      // @ts-expect-error - _buildInterceptors is private
      const interceptors = plugin._buildInterceptors(options);

      expect(interceptors).toHaveLength(4); // telemetry + timeout + retry + cache

      // Import interceptor classes dynamically to avoid module resolution issues
      const { TelemetryInterceptor } = await import(
        "../interceptors/telemetry"
      );
      const { TimeoutInterceptor } = await import("../interceptors/timeout");
      const { RetryInterceptor } = await import("../interceptors/retry");
      const { CacheInterceptor } = await import("../interceptors/cache");

      expect(TelemetryInterceptor).toHaveBeenCalledWith(
        mockTelemetry,
        options.telemetryInterceptor,
      );
      expect(TimeoutInterceptor).toHaveBeenCalledWith(5000);
      expect(RetryInterceptor).toHaveBeenCalledWith({
        enabled: true,
        attempts: 3,
      });
      expect(CacheInterceptor).toHaveBeenCalledWith(mockCache, {
        enabled: true,
        cacheKey: ["test"],
      });
    });

    test("should skip disabled interceptors", () => {
      const configWithoutTelemetry = {
        ...config,
        telemetry: { metrics: false, traces: false, logs: false },
      };
      const plugin = new TestPlugin(configWithoutTelemetry);

      const options: PluginExecuteConfig = {
        timeout: 0, // disabled
        retry: { enabled: false, attempts: 3 }, // disabled
        cache: { enabled: true, cacheKey: [] }, // disabled (empty cacheKey)
      };

      // @ts-expect-error - _buildInterceptors is private
      const interceptors = plugin._buildInterceptors(options);

      expect(interceptors).toHaveLength(0);
    });

    test("should skip timeout interceptor when timeout is 0 or negative", () => {
      const configWithoutTelemetry = {
        ...config,
        telemetry: { metrics: false, traces: false, logs: false },
      };
      const plugin = new TestPlugin(configWithoutTelemetry);

      const options1: PluginExecuteConfig = { timeout: 0 };
      const options2: PluginExecuteConfig = { timeout: -100 };

      // @ts-expect-error - _buildInterceptors is private
      const interceptors1 = plugin._buildInterceptors(options1);
      // @ts-expect-error - _buildInterceptors is private
      const interceptors2 = plugin._buildInterceptors(options2);

      expect(interceptors1).toHaveLength(0);
      expect(interceptors2).toHaveLength(0);
    });

    test("should skip retry interceptor when attempts <= 1", () => {
      const configWithoutTelemetry = {
        ...config,
        telemetry: { metrics: false, traces: false, logs: false },
      };
      const plugin = new TestPlugin(configWithoutTelemetry);

      const options: PluginExecuteConfig = {
        retry: { enabled: true, attempts: 1 },
      };

      // @ts-expect-error - _buildInterceptors is private
      const interceptors = plugin._buildInterceptors(options);

      expect(interceptors).toHaveLength(0);
    });

    test("should skip cache interceptor when cacheKey is empty", () => {
      const configWithoutTelemetry = {
        ...config,
        telemetry: {
          metrics: false,
          traces: false,
          logs: false,
        },
      };
      const plugin = new TestPlugin(configWithoutTelemetry);

      const options: PluginExecuteConfig = {
        cache: { enabled: true, cacheKey: [] },
      };

      // @ts-expect-error - _buildInterceptors is private
      const interceptors = plugin._buildInterceptors(options);

      expect(interceptors).toHaveLength(0);
    });
  });

  describe("_executeWithInterceptors", () => {
    test("should execute function directly when no interceptors", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi.fn().mockResolvedValue("direct-result");
      const context: InterceptorContext = {
        metadata: new Map(),
        userKey: "test",
      };

      // @ts-expect-error - _executeWithInterceptors is private
      const result = await plugin._executeWithInterceptors(mockFn, [], context);

      expect(result).toBe("direct-result");
      expect(mockFn).toHaveBeenCalledWith(context.signal);
    });

    test("should chain interceptors correctly", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi.fn().mockResolvedValue("chained-result");
      const context: InterceptorContext = {
        metadata: new Map(),
        userKey: "test",
      };

      const mockInterceptor1 = {
        intercept: vi.fn().mockImplementation((fn) => fn()),
      };
      const mockInterceptor2 = {
        intercept: vi.fn().mockImplementation((fn) => fn()),
      };

      // @ts-expect-error - _executeWithInterceptors is private
      const result = await plugin._executeWithInterceptors(
        mockFn,
        [mockInterceptor1, mockInterceptor2],
        context,
      );

      expect(result).toBe("chained-result");
      expect(mockInterceptor1.intercept).toHaveBeenCalledTimes(1);
      expect(mockInterceptor2.intercept).toHaveBeenCalledTimes(1);
    });

    test("should pass context to interceptors", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi.fn().mockResolvedValue("context-result");
      const context: InterceptorContext = {
        metadata: new Map(),
        signal: new AbortController().signal,
        userKey: "test",
      };

      const mockInterceptor = {
        intercept: vi.fn().mockImplementation((fn, ctx) => {
          expect(ctx).toBe(context);
          return fn();
        }),
      };

      // @ts-expect-error - _executeWithInterceptors is private
      await plugin._executeWithInterceptors(mockFn, [mockInterceptor], context);

      expect(mockInterceptor.intercept).toHaveBeenCalledWith(
        expect.any(Function),
        context,
      );
    });
  });

  describe("exports", () => {
    test("should return empty object by default", () => {
      const plugin = new TestPlugin(config);
      const basePlugin = new (class extends Plugin<BasePluginConfig> {})(
        config,
      );

      expect(basePlugin.exports()).toEqual({});
      expect(plugin.exports()).toEqual({
        customMethod: expect.any(Function),
        syncMethod: expect.any(Function),
      });
    });
  });

  describe("clientConfig", () => {
    test("should return empty object by default", () => {
      const plugin = new TestPlugin(config);
      expect(plugin.clientConfig()).toEqual({});
    });

    test("should allow overriding to expose custom data", () => {
      class PluginWithClientConfig extends Plugin<BasePluginConfig> {
        clientConfig() {
          return { featureFlag: true, warehouseId: "abc-123" };
        }
      }

      const plugin = new PluginWithClientConfig(config);
      expect(plugin.clientConfig()).toEqual({
        featureFlag: true,
        warehouseId: "abc-123",
      });
    });
  });

  describe("getSkipBodyParsingPaths", () => {
    test("should return empty set by default", () => {
      const plugin = new TestPlugin(config);

      expect(plugin.getSkipBodyParsingPaths().size).toBe(0);
    });

    test("should include paths from routes with skipBodyParsing: true", () => {
      const plugin = new TestPlugin({ ...config, name: "test" });
      const mockRouter = {
        post: vi.fn(),
      } as any;

      (plugin as any).route(mockRouter, {
        name: "upload",
        method: "post",
        path: "/upload",
        skipBodyParsing: true,
        handler: vi.fn(),
      });

      const paths = plugin.getSkipBodyParsingPaths();
      expect(paths.has("/api/test/upload")).toBe(true);
      expect(paths.size).toBe(1);
    });

    test("should not include paths from routes without skipBodyParsing", () => {
      const plugin = new TestPlugin({ ...config, name: "test" });
      const mockRouter = {
        post: vi.fn(),
      } as any;

      (plugin as any).route(mockRouter, {
        name: "create",
        method: "post",
        path: "/create",
        handler: vi.fn(),
      });

      const paths = plugin.getSkipBodyParsingPaths();
      expect(paths.size).toBe(0);
    });
  });

  describe("static properties", () => {
    test("should have default phase of 'normal'", () => {
      expect(Plugin.phase).toBe("normal");
    });
  });

  describe("integration scenarios", () => {
    test("should handle complex execution flow with all interceptors", async () => {
      const plugin = new TestPlugin({
        name: "integration-test",
        timeout: 2000,
        cache: { enabled: true, cacheKey: ["key"] },
        retry: { enabled: true, attempts: 2 },
      });

      const mockFn = vi.fn().mockResolvedValue("integration-result");

      // @ts-expect-error - execute is protected
      const result = await plugin.execute(mockFn, {
        default: { timeout: 1000 },
        user: { retry: { attempts: 3 } },
      });

      expect(result).toEqual({ ok: true, data: "integration-result" });
    });
  });

  describe("asUser() dev fallback", () => {
    let originalNodeEnv: string | undefined;
    let contextManager: ContextManager;

    beforeAll(() => {
      otelContext.disable();
      contextManager = new AsyncLocalStorageContextManager().enable();
      otelContext.setGlobalContextManager(contextManager);
    });

    afterAll(() => {
      otelContext.disable();
    });

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      vi.useRealTimers();
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    function createMockReqWithoutToken(): express.Request {
      return {
        header: vi.fn().mockReturnValue(undefined),
      } as unknown as express.Request;
    }

    test("should return a Proxy (different reference) in dev mode without token", () => {
      const plugin = new TestPlugin(config);
      const proxied = plugin.asUser(createMockReqWithoutToken());

      expect(proxied).not.toBe(plugin);
      expect(proxied).toBeInstanceOf(TestPlugin);
    });

    test("should pass through non-function properties unchanged", () => {
      const plugin = new TestPlugin(config);
      const proxied = plugin.asUser(createMockReqWithoutToken());

      expect(proxied.name).toBe(plugin.name);
    });

    test("should preserve return values from proxied async methods", async () => {
      const plugin = new TestPlugin(config);
      const proxied = plugin.asUser(createMockReqWithoutToken());

      const result = await proxied.customMethod("value");
      expect(result).toBe("processed-value");
    });

    test("should preserve return values from proxied sync methods", () => {
      const plugin = new TestPlugin(config);
      const proxied = plugin.asUser(createMockReqWithoutToken());

      const result = proxied.syncMethod("value");
      expect(result).toBe("sync-value");
    });

    test("should set isDevOboFallback() to true inside proxied method", async () => {
      const plugin = new OboTestPlugin(config);
      const proxied = plugin.asUser(createMockReqWithoutToken());

      await proxied.captureOboFallback();

      expect(plugin.lastOboFallbackValue).toBe(true);
    });

    test("should set isDevOboFallback() to true inside proxied sync method", () => {
      const plugin = new OboTestPlugin(config);
      const proxied = plugin.asUser(createMockReqWithoutToken());

      proxied.syncCapture();

      expect(plugin.lastOboFallbackValue).toBe(true);
    });

    test("should not set OBO fallback for excluded methods (setup)", async () => {
      const plugin = new OboTestPlugin(config);
      // Override setup to capture OBO fallback
      plugin.setup = async () => {
        plugin.lastOboFallbackValue = isDevOboFallback();
      };

      const proxied = plugin.asUser(createMockReqWithoutToken());
      await proxied.setup();

      expect(plugin.lastOboFallbackValue).toBe(false);
    });

    test("isDevOboFallback() should return false outside proxy context", () => {
      expect(isDevOboFallback()).toBe(false);
    });
  });

  describe("executeStream OTel context preservation", () => {
    let contextManager: ContextManager;

    beforeAll(() => {
      otelContext.disable();
      contextManager = new AsyncLocalStorageContextManager().enable();
      otelContext.setGlobalContextManager(contextManager);
    });

    afterAll(() => {
      otelContext.disable();
    });

    beforeEach(() => {
      vi.useRealTimers();
    });

    test("should preserve parent OTel context inside async generator", async () => {
      const plugin = new TestPlugin(config);
      const mockResponse = {} as IAppResponse;

      const TEST_KEY = createContextKey("test.parent.context");
      const parentCtx = otelContext.active().setValue(TEST_KEY, "parent-value");

      let capturedContextValue: unknown;

      const mockFn = vi.fn().mockImplementation(async () => {
        capturedContextValue = otelContext.active().getValue(TEST_KEY);
        return "stream-result";
      });

      // Capture the generator function passed to streamManager.stream
      let capturedGeneratorFn: any;
      vi.mocked(mockStreamManager.stream).mockImplementation(
        async (_res, genFn) => {
          capturedGeneratorFn = genFn;
        },
      );

      // Execute within the parent context
      await otelContext.with(parentCtx, () =>
        (plugin as any).executeStream(mockResponse, mockFn, {
          default: {},
          stream: {},
        }),
      );

      // Invoke the captured generator OUTSIDE the parent context scope
      // The generator should restore parentOtelContext internally
      const gen = capturedGeneratorFn();
      await gen.next();

      expect(capturedContextValue).toBe("parent-value");
    });

    test("should not have parent context without the fix (baseline)", async () => {
      const TEST_KEY = createContextKey("test.baseline.context");

      // Outside any context, the value should not exist
      expect(otelContext.active().getValue(TEST_KEY)).toBeUndefined();
    });
  });
});
