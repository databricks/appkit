import { AppManager } from "@databricks-apps/app";
import { CacheManager } from "@databricks-apps/cache";
import { StreamManager } from "@databricks-apps/stream";
import type {
  BasePluginConfig,
  ExecuteOptions,
  IAppResponse,
  IAuthManager,
} from "@databricks-apps/types";
import { validateEnv } from "@databricks-apps/utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type express from "express";
import { Plugin } from "../src/plugin";
import type { ExecutionContext } from "../src/interceptors/types";

// Mock all dependencies
vi.mock("@databricks-apps/app");
vi.mock("@databricks-apps/cache");
vi.mock("@databricks-apps/stream");
vi.mock("@databricks-apps/utils", () => ({
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

// Mock interceptors
vi.mock("../src/interceptors/cache", () => ({
  CacheInterceptor: vi.fn().mockImplementation((_cache, _config) => ({
    intercept: vi.fn().mockImplementation((fn, _context) => fn()),
  })),
}));

vi.mock("../src/interceptors/retry", () => ({
  RetryInterceptor: vi.fn().mockImplementation((_config) => ({
    intercept: vi.fn().mockImplementation((fn, _context) => fn()),
  })),
}));

vi.mock("../src/interceptors/timeout", () => ({
  TimeoutInterceptor: vi.fn().mockImplementation((_timeout) => ({
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

  async parallelAsyncWork(
    workId: string,
    duration: number = 5,
    executionDetails: any[] = [],
  ) {
    const threadId = Math.random().toString(36).substring(7);

    // Phase 1: Start
    executionDetails.push({
      id: workId,
      phase: "start",
      token: this.userToken,
      timestamp: Date.now(),
      threadId,
    });

    // Simulate async work that could be interrupted
    await new Promise((resolve) => setTimeout(resolve, duration));

    // Phase 2: Middle (check token is still correct after async gap)
    executionDetails.push({
      id: workId,
      phase: "middle",
      token: this.userToken,
      timestamp: Date.now(),
      threadId,
    });

    // Another async gap
    await new Promise((resolve) => setTimeout(resolve, duration));

    // Phase 3: End
    executionDetails.push({
      id: workId,
      phase: "end",
      token: this.userToken,
      timestamp: Date.now(),
      threadId,
    });

    return `completed-${workId}-with-${this.userToken || "no-token"}`;
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
  let mockAuth: IAuthManager;
  let mockCache: CacheManager;
  let mockApp: AppManager;
  let mockStreamManager: StreamManager;
  let config: BasePluginConfig;

  beforeEach(() => {
    vi.useFakeTimers();

    // Setup mocks
    mockAuth = {
      getAccessToken: vi.fn(),
      validateToken: vi.fn(),
    } as any;

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
    vi.mocked(CacheManager).mockImplementation(() => mockCache);
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
    test("should initialize with provided config and auth", () => {
      const plugin = new TestPlugin(config, mockAuth);

      expect(plugin.name).toBe("test-plugin");
      expect(plugin.auth).toBe(mockAuth);
      expect(plugin.isReady).toBe(true);
    });

    test("should use default name when not provided in config", () => {
      const configWithoutName = { ...config, name: undefined };
      const plugin = new TestPlugin(configWithoutName, mockAuth);

      expect(plugin.name).toBe("plugin");
    });

    test("should initialize managers", () => {
      new TestPlugin(config, mockAuth);

      expect(CacheManager).toHaveBeenCalledTimes(1);
      expect(AppManager).toHaveBeenCalledTimes(1);
      expect(StreamManager).toHaveBeenCalledTimes(1);
    });
  });

  describe("validateEnv", () => {
    test("should call validateEnv with plugin envVars", () => {
      const plugin = new TestPlugin(config, mockAuth);

      plugin.validateEnv();

      expect(validateEnv).toHaveBeenCalledWith(["TEST_ENV_VAR"]);
    });

    test("should propagate validation errors", () => {
      vi.mocked(validateEnv).mockImplementation(() => {
        throw new Error("Validation failed");
      });

      const plugin = new TestPlugin(config, mockAuth);

      expect(() => plugin.validateEnv()).toThrow("Validation failed");
    });
  });

  describe("setup", () => {
    test("should have empty default setup", async () => {
      const plugin = new TestPlugin(config, mockAuth);

      await expect(plugin.setup()).resolves.toBeUndefined();
    });

    test("should allow custom setup implementation", async () => {
      vi.useRealTimers(); // Use real timers for this test

      const plugin = new PluginWithCustomSetup(config, mockAuth);

      await plugin.setup();

      expect(plugin.setupCalled).toBe(true);

      vi.useFakeTimers(); // Restore fake timers
    });
  });

  describe("injectRoutes", () => {
    test("should have empty default implementation", () => {
      const plugin = new TestPlugin(config, mockAuth);
      const mockRouter = {} as express.Router;

      expect(() => plugin.injectRoutes(mockRouter)).not.toThrow();
    });

    test("should allow custom route injection", () => {
      const plugin = new PluginWithRoutes(config, mockAuth);
      const mockRouter = {} as express.Router;

      plugin.injectRoutes(mockRouter);

      expect(plugin.routesInjected).toBe(true);
    });
  });

  describe("abortActiveOperations", () => {
    test("should call streamManager.abortAll", () => {
      const plugin = new TestPlugin(config, mockAuth);

      plugin.abortActiveOperations();

      expect(mockStreamManager.abortAll).toHaveBeenCalledTimes(1);
    });
  });

  describe("asUser", () => {
    test("should throw error if userToken is empty", () => {
      const plugin = new TestPlugin(config, mockAuth);

      expect(() => plugin.asUser("")).toThrow("User token is required");
      expect(() => plugin.asUser(undefined as any)).toThrow(
        "User token is required",
      );
    });

    test("should return proxy that injects user token for sync methods", () => {
      const plugin = new TestPlugin(config, mockAuth);
      const userPlugin = plugin.asUser("user-token-123");

      const result = userPlugin.syncMethod("test");

      expect(result).toBe("sync-test");
    });

    test("should return proxy that injects user token for async methods", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const userPlugin = plugin.asUser("user-token-123");

      const result = await userPlugin.customMethod("test");

      expect(result).toBe("processed-test");
    });

    test("should clear user token after sync method execution", () => {
      const plugin = new TestPlugin(config, mockAuth);
      const userPlugin = plugin.asUser("user-token-123");

      userPlugin.syncMethod("test");

      expect(plugin.userToken).toBeUndefined();
    });

    test("should clear user token after async method execution", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const userPlugin = plugin.asUser("user-token-123");

      await userPlugin.customMethod("test");

      expect(plugin.userToken).toBeUndefined();
    });

    test("should clear user token on sync method error", () => {
      const plugin = new TestPlugin(config, mockAuth);
      const userPlugin = plugin.asUser("user-token-123");

      expect(() => userPlugin.methodThatThrows()).toThrow("Method error");
      expect(plugin.userToken).toBeUndefined();
    });

    test("should clear user token on async method error", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const userPlugin = plugin.asUser("user-token-123");

      await expect(userPlugin.asyncMethodThatThrows()).rejects.toThrow(
        "Async method error",
      );
      expect(plugin.userToken).toBeUndefined();
    });

    test("should access non-function properties directly", () => {
      const plugin = new TestPlugin(config, mockAuth);
      const userPlugin = plugin.asUser("user-token-123");

      expect(userPlugin.name).toBe(plugin.name);
    });

    test("should provide access to userToken during method execution", () => {
      const plugin = new TestPlugin(config, mockAuth);

      // Add a method that checks userToken
      (plugin as any).checkUserToken = function () {
        return this.userToken;
      };

      const userPlugin = plugin.asUser("user-token-123");
      const result = (userPlugin as any).checkUserToken();

      expect(result).toBe("user-token-123");
    });

    test("should isolate user tokens between asUser and direct method calls", () => {
      const plugin = new TestPlugin(config, mockAuth);

      // Add methods to capture userToken at different points
      const capturedTokens: (string | undefined)[] = [];
      (plugin as any).captureToken = function () {
        capturedTokens.push(this.userToken);
        return `token-${this.userToken || "none"}`;
      };

      const userPlugin = plugin.asUser("user-123");

      // Call method with asUser - should have token
      const userResult = (userPlugin as any).captureToken();

      // Call method directly on plugin - should NOT have token
      const directResult = (plugin as any).captureToken();

      // Call another asUser method - should have token again
      const userResult2 = (userPlugin as any).captureToken();

      expect(userResult).toBe("token-user-123");
      expect(directResult).toBe("token-none");
      expect(userResult2).toBe("token-user-123");

      // Verify the captured tokens
      expect(capturedTokens).toEqual(["user-123", undefined, "user-123"]);
    });

    test("should not contaminate between different asUser instances", async () => {
      const plugin = new TestPlugin(config, mockAuth);

      // Add method to capture token during execution
      const capturedTokens: (string | undefined)[] = [];
      (plugin as any).captureAsyncToken = async function () {
        capturedTokens.push(this.userToken);
        return `async-token-${this.userToken || "none"}`;
      };

      const userPlugin1 = plugin.asUser("user-alice");
      const userPlugin2 = plugin.asUser("user-bob");

      // Execute methods sequentially to test proper token isolation
      // (concurrent execution would show that the last token wins due to shared state)
      const result1 = await (userPlugin1 as any).captureAsyncToken();
      const result2 = await (userPlugin2 as any).captureAsyncToken();
      const result3 = await (plugin as any).captureAsyncToken(); // Direct call should have no token

      expect(result1).toBe("async-token-user-alice");
      expect(result2).toBe("async-token-user-bob");
      expect(result3).toBe("async-token-none");

      // Verify each execution saw the correct token
      expect(capturedTokens).toEqual(["user-alice", "user-bob", undefined]);

      // Verify no token remains after all executions
      expect(plugin.userToken).toBeUndefined();
    });

    test("should handle interleaved sync and async calls without contamination", async () => {
      vi.useRealTimers(); // Use real timers for async operations

      const plugin = new TestPlugin(config, mockAuth);

      const executionLog: Array<{
        method: string;
        token: string | undefined;
        timestamp: number;
      }> = [];

      // Add methods to log execution with timestamps
      (plugin as any).syncCapture = function (id: string) {
        executionLog.push({
          method: `sync-${id}`,
          token: this.userToken,
          timestamp: Date.now(),
        });
        return this.userToken;
      };

      (plugin as any).asyncCapture = async function (id: string) {
        executionLog.push({
          method: `async-start-${id}`,
          token: this.userToken,
          timestamp: Date.now(),
        });

        // Simulate async work (minimal delay to avoid timeout)
        await new Promise((resolve) => setTimeout(resolve, 1));

        executionLog.push({
          method: `async-end-${id}`,
          token: this.userToken,
          timestamp: Date.now(),
        });

        return this.userToken;
      };

      const userPlugin1 = plugin.asUser("token-1");
      const userPlugin2 = plugin.asUser("token-2");

      // Test interleaved execution patterns
      const syncResult1 = (userPlugin1 as any).syncCapture("1");
      const directSyncResult = (plugin as any).syncCapture("direct");
      const syncResult2 = (userPlugin2 as any).syncCapture("2");

      // Test async execution with different tokens
      const asyncResult1 = await (userPlugin1 as any).asyncCapture("1");
      const asyncResult2 = await (userPlugin2 as any).asyncCapture("2");

      // Verify results
      expect(syncResult1).toBe("token-1");
      expect(syncResult2).toBe("token-2");
      expect(directSyncResult).toBeUndefined();
      expect(asyncResult1).toBe("token-1");
      expect(asyncResult2).toBe("token-2");

      // Verify execution log shows proper token isolation
      const tokenLog = executionLog.map((entry) => ({
        method: entry.method,
        token: entry.token,
      }));

      expect(tokenLog).toContainEqual({ method: "sync-1", token: "token-1" });
      expect(tokenLog).toContainEqual({ method: "sync-2", token: "token-2" });
      expect(tokenLog).toContainEqual({
        method: "sync-direct",
        token: undefined,
      });
      expect(tokenLog).toContainEqual({
        method: "async-start-1",
        token: "token-1",
      });
      expect(tokenLog).toContainEqual({
        method: "async-end-1",
        token: "token-1",
      });
      expect(tokenLog).toContainEqual({
        method: "async-start-2",
        token: "token-2",
      });
      expect(tokenLog).toContainEqual({
        method: "async-end-2",
        token: "token-2",
      });

      // Verify no token contamination remains
      expect(plugin.userToken).toBeUndefined();

      vi.useFakeTimers(); // Restore fake timers for other tests
    });

    test("should maintain token isolation during parallel async execution", async () => {
      vi.useRealTimers(); // Use real timers for true parallel execution

      const plugin = new TestPlugin(config, mockAuth);

      // Track execution details with precise timing
      const executionDetails: Array<{
        id: string;
        phase: string;
        token: string | undefined;
        timestamp: number;
        threadId: string;
      }> = [];

      // Execute multiple async operations in TRUE parallel
      const parallelPromises = [
        plugin
          .asUser("alice-token")
          .parallelAsyncWork("task-1", 10, executionDetails),
        plugin
          .asUser("bob-token")
          .parallelAsyncWork("task-2", 8, executionDetails),
        plugin
          .asUser("charlie-token")
          .parallelAsyncWork("task-3", 12, executionDetails),
        (plugin as any).parallelAsyncWork("direct-task", 6, executionDetails), // Direct call - no token
        plugin
          .asUser("alice-token")
          .parallelAsyncWork("task-1b", 7, executionDetails), // Same user, different task
      ];

      const results = await Promise.all(parallelPromises);

      console.log("Parallel execution results:");
      results.forEach((result, index) => {
        console.log(`  [${index}]: ${result}`);
      });

      // Document what actually happens instead of what should happen
      console.log("\nExecution details showing token contamination:");
      const groupedDetails = executionDetails.reduce(
        (acc, detail) => {
          if (!acc[detail.id]) acc[detail.id] = [];
          acc[detail.id].push(detail);
          return acc;
        },
        {} as Record<string, typeof executionDetails>,
      );

      Object.entries(groupedDetails).forEach(([taskId, details]) => {
        console.log(`\n${taskId}:`);
        details.forEach((d) => {
          console.log(`  ${d.phase}: token="${d.token}" at ${d.timestamp}`);
        });
      });

      // These should all pass now that AsyncLocalStorage provides proper token isolation
      expect(results[0]).toBe("completed-task-1-with-alice-token");
      expect(results[1]).toBe("completed-task-2-with-bob-token");
      expect(results[2]).toBe("completed-task-3-with-charlie-token");
      expect(results[3]).toBe("completed-direct-task-with-no-token");
      expect(results[4]).toBe("completed-task-1b-with-alice-token");

      // Verify no token contamination occurred
      const hasContamination = results.some(
        (result) =>
          result.includes("with-no-token") && !result.includes("direct-task"),
      );

      expect(hasContamination).toBe(false); // No contamination should exist

      // Verify execution was truly parallel
      const allTimestamps = executionDetails.map((d) => d.timestamp).sort();
      const timeSpread =
        allTimestamps[allTimestamps.length - 1] - allTimestamps[0];
      expect(timeSpread).toBeLessThan(30); // Proves parallel execution

      // Verify no tokens were lost due to race conditions
      const tokenLossCount = executionDetails.filter(
        (d) => d.token === undefined && !d.id.includes("direct"),
      ).length;

      console.log(
        `\nTokens lost due to race condition: ${tokenLossCount} out of ${
          executionDetails.length - 3
        } user operations`,
      );

      expect(tokenLossCount).toBe(0); // No tokens should be lost

      vi.useFakeTimers(); // Restore fake timers
    });
  });

  describe("userToken getter", () => {
    test("should return undefined when no user token is set", () => {
      const plugin = new TestPlugin(config, mockAuth);

      expect(plugin.userToken).toBeUndefined();
    });

    test("should return current user token when set via asUser", () => {
      const plugin = new TestPlugin(config, mockAuth);

      // Add a method to access userToken
      (plugin as any).getCurrentToken = function () {
        return this.userToken;
      };

      const userPlugin = plugin.asUser("test-token");
      const token = (userPlugin as any).getCurrentToken();

      expect(token).toBe("test-token");
    });
  });

  describe("executeStream", () => {
    test("should call streamManager.stream with correct parameters", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const mockResponse = {} as IAppResponse;
      const mockFn = vi.fn().mockResolvedValue("result");

      const options = {
        default: { timeout: 1000 },
        user: { timeout: 2000 },
      };

      await plugin.executeStream(mockResponse, mockFn, options);

      expect(mockStreamManager.stream).toHaveBeenCalledTimes(1);
      expect(mockStreamManager.stream).toHaveBeenCalledWith(
        mockResponse,
        expect.any(Function),
        undefined,
      );
    });

    test("should capture user token at execution time", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const mockResponse = {} as IAppResponse;

      let capturedToken: string | undefined;
      const mockFn = vi.fn().mockImplementation(() => {
        capturedToken = plugin.userToken;
        return Promise.resolve("result");
      });

      // Mock streamManager.stream to actually call the generator function
      vi.mocked(mockStreamManager.stream).mockImplementation(
        async (_res, genFn) => {
          const gen = genFn();
          await gen.next();
        },
      );

      const userPlugin = plugin.asUser("stream-token");
      await (userPlugin as any).executeStream(mockResponse, mockFn, {
        default: {},
      });

      expect(capturedToken).toBe("stream-token");
    });

    test("should build execution options correctly", async () => {
      const plugin = new TestPlugin(config, mockAuth);
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
      };

      await plugin.executeStream(mockResponse, mockFn, options);

      expect(mockStreamManager.stream).toHaveBeenCalled();
    });
  });

  describe("execute", () => {
    test("should execute function with interceptors", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const mockFn = vi.fn().mockResolvedValue("result");

      const options = {
        default: { timeout: 1000 },
        user: { timeout: 2000 },
      };

      const result = await plugin.execute(mockFn, options);

      expect(result).toBe("result");
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test("should return undefined on function error (production-safe)", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const mockFn = vi.fn().mockRejectedValue(new Error("Test error"));

      const options = {
        default: {},
      };

      const result = await plugin.execute(mockFn, options);

      expect(result).toBeUndefined();
    });

    test("should capture user token in execution context", async () => {
      const plugin = new TestPlugin(config, mockAuth);

      let capturedContext: ExecutionContext | undefined;
      const mockFn = vi.fn().mockResolvedValue("result");

      // Mock the _executeWithInterceptors method to capture context
      plugin._executeWithInterceptors = vi
        .fn()
        .mockImplementation((fn, _interceptors, context) => {
          capturedContext = context;
          return fn();
        });

      const userPlugin = plugin.asUser("execute-token");
      await (userPlugin as any).execute(mockFn, { default: {} });

      expect(capturedContext?.userToken).toBe("execute-token");
    });
  });

  describe("_buildExecutionOptions", () => {
    test("should merge options in correct priority order", () => {
      const plugin = new TestPlugin(
        {
          name: "test",
          timeout: 3000,
          cache: { enabled: true },
        },
        mockAuth,
      );

      const methodDefaults = { timeout: 1000, retry: { attempts: 2 } };
      const userOverride = { timeout: 5000 };

      const result = (plugin as any)._buildExecutionConfig({
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
      const plugin = new TestPlugin({ name: "test", timeout: 2000 }, mockAuth);

      const methodDefaults = { timeout: 1000 };

      const result = (plugin as any)._buildExecutionConfig({
        default: methodDefaults,
      });

      expect(result.timeout).toBe(2000); // Plugin config wins
    });
  });

  describe("_buildInterceptors", () => {
    test("should build interceptors in correct order", async () => {
      const plugin = new TestPlugin(config, mockAuth);

      const options: ExecuteOptions = {
        timeout: 5000,
        retry: { enabled: true, attempts: 3 },
        cache: { enabled: true, cacheKey: ["test"] },
      };

      const interceptors = plugin._buildInterceptors(options);

      expect(interceptors).toHaveLength(3);

      // Import interceptor classes dynamically to avoid module resolution issues
      const { TimeoutInterceptor } = await import(
        "../src/interceptors/timeout"
      );
      const { RetryInterceptor } = await import("../src/interceptors/retry");
      const { CacheInterceptor } = await import("../src/interceptors/cache");

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
      const plugin = new TestPlugin(config, mockAuth);

      const options: ExecuteOptions = {
        timeout: 0, // disabled
        retry: { enabled: false, attempts: 3 }, // disabled
        cache: { enabled: true, cacheKey: [] }, // disabled (empty cacheKey)
      };

      const interceptors = plugin._buildInterceptors(options);

      expect(interceptors).toHaveLength(0);
    });

    test("should skip timeout interceptor when timeout is 0 or negative", () => {
      const plugin = new TestPlugin(config, mockAuth);

      const options1: ExecuteOptions = { timeout: 0 };
      const options2: ExecuteOptions = { timeout: -100 };

      const interceptors1 = plugin._buildInterceptors(options1);
      const interceptors2 = plugin._buildInterceptors(options2);

      expect(interceptors1).toHaveLength(0);
      expect(interceptors2).toHaveLength(0);
    });

    test("should skip retry interceptor when attempts <= 1", () => {
      const plugin = new TestPlugin(config, mockAuth);

      const options: ExecuteOptions = {
        retry: { enabled: true, attempts: 1 },
      };

      const interceptors = plugin._buildInterceptors(options);

      expect(interceptors).toHaveLength(0);
    });

    test("should skip cache interceptor when cacheKey is empty", () => {
      const plugin = new TestPlugin(config, mockAuth);

      const options: ExecuteOptions = {
        cache: { enabled: true, cacheKey: [] },
      };

      const interceptors = plugin._buildInterceptors(options);

      expect(interceptors).toHaveLength(0);
    });
  });

  describe("_executeWithInterceptors", () => {
    test("should execute function directly when no interceptors", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const mockFn = vi.fn().mockResolvedValue("direct-result");
      const context: ExecutionContext = { metadata: new Map() };

      const result = await plugin._executeWithInterceptors(mockFn, [], context);

      expect(result).toBe("direct-result");
      expect(mockFn).toHaveBeenCalledWith(context.signal);
    });

    test("should chain interceptors correctly", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const mockFn = vi.fn().mockResolvedValue("chained-result");
      const context: ExecutionContext = { metadata: new Map() };

      const mockInterceptor1 = {
        intercept: vi.fn().mockImplementation((fn) => fn()),
      };
      const mockInterceptor2 = {
        intercept: vi.fn().mockImplementation((fn) => fn()),
      };

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
      const plugin = new TestPlugin(config, mockAuth);
      const mockFn = vi.fn().mockResolvedValue("context-result");
      const context: ExecutionContext = {
        metadata: new Map(),
        userToken: "test-token",
        signal: new AbortController().signal,
      };

      const mockInterceptor = {
        intercept: vi.fn().mockImplementation((fn, ctx) => {
          expect(ctx).toBe(context);
          return fn();
        }),
      };

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

  describe("integration scenarios", () => {
    test("should handle complex execution flow with all interceptors", async () => {
      const plugin = new TestPlugin(
        {
          name: "integration-test",
          timeout: 2000,
          cache: { enabled: true, cacheKey: ["key"] },
          retry: { enabled: true, attempts: 2 },
        },
        mockAuth,
      );

      const mockFn = vi.fn().mockResolvedValue("integration-result");

      const result = await plugin.execute(mockFn, {
        default: { timeout: 1000 },
        user: { retry: { attempts: 3 } },
      });

      expect(result).toBe("integration-result");
    });

    test("should handle user context across multiple method calls", async () => {
      const plugin = new TestPlugin(config, mockAuth);
      const userPlugin = plugin.asUser("multi-call-token");

      const result1 = userPlugin.syncMethod("call1");
      const result2 = await userPlugin.customMethod("call2");

      expect(result1).toBe("sync-call1");
      expect(result2).toBe("processed-call2");
      expect(plugin.userToken).toBeUndefined();
    });
  });
});
