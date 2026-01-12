import type express from "express";
import type {
  BasePluginConfig,
  IAppResponse,
  PluginExecuteConfig,
} from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppManager } from "../../app";
import { CacheManager } from "../../cache";
import { StreamManager } from "../../stream";
import { validateEnv } from "../../utils";
import type { ExecutionContext } from "../interceptors/types";
import { Plugin } from "../plugin";

// Mock all dependencies
vi.mock("../../app");
vi.mock("../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(),
  },
}));
vi.mock("../../stream");
vi.mock("../../utils", () => ({
  validateEnv: vi.fn(),
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
  envVars = ["TEST_ENV_VAR"];

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

describe("Plugin", () => {
  let mockCache: CacheManager;
  let mockApp: AppManager;
  let mockStreamManager: StreamManager;
  let config: BasePluginConfig;

  beforeEach(() => {
    vi.useFakeTimers();

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
    vi.mocked(validateEnv).mockImplementation(() => {});

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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

  describe("validateEnv", () => {
    test("should call validateEnv with plugin envVars", () => {
      const plugin = new TestPlugin(config);

      plugin.validateEnv();

      expect(validateEnv).toHaveBeenCalledWith(["TEST_ENV_VAR"]);
    });

    test("should propagate validation errors", () => {
      vi.mocked(validateEnv).mockImplementation(() => {
        throw new Error("Validation failed");
      });

      const plugin = new TestPlugin(config);

      expect(() => plugin.validateEnv()).toThrow("Validation failed");
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
    test("should execute function with interceptors", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi.fn().mockResolvedValue("result");

      const options = {
        default: { timeout: 1000 },
        user: { timeout: 2000 },
      };

      const result = await (plugin as any).execute(mockFn, options, false);

      expect(result).toBe("result");
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test("should return undefined on function error (production-safe)", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi.fn().mockRejectedValue(new Error("Test error"));

      const options = {
        default: {},
      };

      const result = await (plugin as any).execute(mockFn, options, false);

      expect(result).toBeUndefined();
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

      const { ObservabilityInterceptor } = await import(
        "../interceptors/observability"
      );
      const { TimeoutInterceptor } = await import("../interceptors/timeout");
      const { RetryInterceptor } = await import("../interceptors/retry");
      const { CacheInterceptor } = await import("../interceptors/cache");

      expect(ObservabilityInterceptor).toHaveBeenCalledWith(expect.any(Object));
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
      const context: ExecutionContext = {
        metadata: new Map(),
        userKey: "test",
        pluginName: plugin.name,
      };

      // @ts-expect-error - _executeWithInterceptors is private
      const result = await plugin._executeWithInterceptors(mockFn, [], context);

      expect(result).toBe("direct-result");
      expect(mockFn).toHaveBeenCalledWith(context.signal);
    });

    test("should chain interceptors correctly", async () => {
      const plugin = new TestPlugin(config);
      const mockFn = vi.fn().mockResolvedValue("chained-result");
      const context: ExecutionContext = {
        pluginName: plugin.name,
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
      const context: ExecutionContext = {
        pluginName: plugin.name,
        metadata: new Map(),
        asUser: true,
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

  describe("static properties", () => {
    test("should have default phase of 'normal'", () => {
      expect(Plugin.phase).toBe("normal");
    });
  });

  describe("requiresDatabricksClient", () => {
    test("should default to false", () => {
      const plugin = new TestPlugin(config);
      expect(plugin.requiresDatabricksClient).toBe(false);
    });

    test("should allow plugins to override to true", () => {
      class PluginWithDatabricksClient extends TestPlugin {
        requiresDatabricksClient = true;
      }

      const plugin = new PluginWithDatabricksClient(config);
      expect(plugin.requiresDatabricksClient).toBe(true);
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

      expect(result).toBe("integration-result");
    });
  });
});
