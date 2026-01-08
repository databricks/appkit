import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { sql } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AnalyticsPlugin, analytics } from "../analytics";
import type { IAnalyticsConfig } from "../types";
import { ServiceContext } from "../../context/service-context";

// Mock CacheManager singleton with actual caching behavior
const { mockCacheStore, mockCacheInstance } = vi.hoisted(() => {
  const store = new Map<string, unknown>();

  const generateKey = (parts: unknown[], userKey: string): string => {
    const { createHash } = require("node:crypto");
    const allParts = [userKey, ...parts];
    const serialized = JSON.stringify(allParts);
    return createHash("sha256").update(serialized).digest("hex");
  };

  const instance = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(
      async (key: unknown[], fn: () => Promise<unknown>, userKey: string) => {
        const cacheKey = generateKey(key, userKey);
        if (store.has(cacheKey)) {
          return store.get(cacheKey);
        }
        const result = await fn();
        store.set(cacheKey, result);
        return result;
      },
    ),
    generateKey: vi.fn((parts: unknown[], userKey: string) =>
      generateKey(parts, userKey),
    ),
  };

  return { mockCacheStore: store, mockCacheInstance: instance };
});

vi.mock("../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("Analytics Plugin", () => {
  let config: IAnalyticsConfig;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    config = { timeout: 5000 };
    setupDatabricksEnv();
    mockCacheStore.clear();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  test("Analytics plugin data should have correct name", () => {
    const pluginData = analytics({} as any);
    expect(pluginData.name).toBe("analytics");
  });

  test("Plugin instance should be created with correct configuration", () => {
    const plugin = new AnalyticsPlugin(config);

    expect(plugin.name).toBe("analytics");
  });

  describe("injectRoutes", () => {
    test("should register POST routes", () => {
      const plugin = new AnalyticsPlugin(config);
      const { router } = createMockRouter();

      plugin.injectRoutes(router);

      expect(router.post).toHaveBeenCalledTimes(2);
      expect(router.post).toHaveBeenCalledWith(
        "/query/:query_key",
        expect.any(Function),
      );
      expect(router.post).toHaveBeenCalledWith(
        "/users/me/query/:query_key",
        expect.any(Function),
      );
    });

    test("/query/:query_key should return 400 when query_key is missing", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: {},
        body: {},
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "query_key is required",
      });
    });

    test("/query/:query_key should execute as service account without user token", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi
        .fn()
        .mockResolvedValue("SELECT * FROM test");

      let capturedWorkspaceClient: any;
      const executeMock = vi
        .fn()
        .mockImplementation((workspaceClient, ..._args) => {
          // Capture the workspaceClient passed
          capturedWorkspaceClient = workspaceClient;
          return Promise.resolve({
            result: { data: [{ id: 1, name: "test" }] },
          });
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {} },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Verify service workspace client is used (from mocked ServiceContext)
      expect(capturedWorkspaceClient).toBeDefined();

      // Verify executeStatement is called
      expect(executeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: "SELECT * FROM test",
          warehouse_id: "test-warehouse-id",
        }),
        expect.any(AbortSignal),
      );

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Cache-Control",
        "no-cache",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Connection",
        "keep-alive",
      );

      expect(mockRes.write).toHaveBeenCalledWith("event: result\n");
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"data":[{"id":1,"name":"test"}]'),
      );

      expect(mockRes.end).toHaveBeenCalled();
    });

    test("/users/me/query/:query_key should execute query with user workspace client", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi
        .fn()
        .mockResolvedValue("SELECT * FROM users WHERE id = :user_id");

      let capturedWorkspaceClient: any;
      const executeMock = vi
        .fn()
        .mockImplementation((workspaceClient, ..._args: any[]) => {
          // Capture the workspaceClient parameter
          capturedWorkspaceClient = workspaceClient;
          return Promise.resolve({
            result: { data: [{ user_id: 123, name: "Alice" }] },
          });
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/users/me/query/:query_key");
      // The request needs both x-forwarded-access-token and x-forwarded-user headers
      const mockReq = createMockRequest({
        params: { query_key: "user_profile" },
        body: { parameters: { user_id: sql.number(123) } },
        headers: {
          "x-forwarded-access-token": "user-token-123",
          "x-forwarded-user": "user-123",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Verify a workspace client is used (created via ServiceContext.createUserContext)
      expect(capturedWorkspaceClient).toBeDefined();

      // Verify the workspace client is passed to SQL connector
      expect(executeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: "SELECT * FROM users WHERE id = :user_id",
          warehouse_id: "test-warehouse-id",
        }),
        expect.any(AbortSignal),
      );

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream",
      );

      expect(mockRes.write).toHaveBeenCalledWith("event: result\n");
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"user_id":123'),
      );

      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should return cached result on second request", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi
        .fn()
        .mockResolvedValue("SELECT * FROM test WHERE foo = :foo");

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ id: 1, name: "cached" }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: { foo: sql.string("bar") } },
      });

      const mockRes1 = createMockResponse();
      await handler(mockReq, mockRes1);

      const mockRes2 = createMockResponse();
      await handler(mockReq, mockRes2);

      expect(executeMock).toHaveBeenCalledTimes(1);

      expect(mockRes1.write).toHaveBeenCalledWith("event: result\n");
      expect(mockRes2.write).toHaveBeenCalledWith("event: result\n");
    });

    test("should cache user-scoped queries separately per user", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi
        .fn()
        .mockResolvedValue("SELECT * FROM users WHERE id = :user_id");

      const executeMock = vi
        .fn()
        .mockResolvedValueOnce({
          result: { data: [{ user_id: 1, name: "Alice" }] },
        })
        .mockResolvedValueOnce({
          result: { data: [{ user_id: 2, name: "Bob" }] },
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/users/me/query/:query_key");

      // User 1's request
      const mockReq1 = createMockRequest({
        params: { query_key: "user_profile" },
        body: { parameters: { user_id: sql.number(1) } },
        headers: {
          "x-forwarded-access-token": "user-token-1",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes1 = createMockResponse();
      await handler(mockReq1, mockRes1);

      // User 2's request - different user, should not use cache
      const mockReq2 = createMockRequest({
        params: { query_key: "user_profile" },
        body: { parameters: { user_id: sql.number(2) } },
        headers: {
          "x-forwarded-access-token": "user-token-2",
          "x-forwarded-user": "user-2",
        },
      });
      const mockRes2 = createMockResponse();
      await handler(mockReq2, mockRes2);

      // User 1's request again - should use cache
      const mockReq1Again = createMockRequest({
        params: { query_key: "user_profile" },
        body: { parameters: { user_id: sql.number(1) } },
        headers: {
          "x-forwarded-access-token": "user-token-1",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes1Again = createMockResponse();
      await handler(mockReq1Again, mockRes1Again);

      expect(executeMock).toHaveBeenCalledTimes(2);

      expect(mockRes1.write).toHaveBeenCalledWith(
        expect.stringContaining('"name":"Alice"'),
      );
      expect(mockRes1Again.write).toHaveBeenCalledWith(
        expect.stringContaining('"name":"Alice"'),
      );

      expect(mockRes2.write).toHaveBeenCalledWith(
        expect.stringContaining('"name":"Bob"'),
      );
    });

    test("should handle AbortSignal cancellation", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi
        .fn()
        .mockResolvedValue("SELECT * FROM test");

      const executeMock = vi
        .fn()
        .mockImplementation(
          async (_workspaceClient: any, _params: any, signal: AbortSignal) => {
            expect(signal).toBeDefined();
            expect(signal).toBeInstanceOf(AbortSignal);
            return { result: { data: [{ id: 1 }] } };
          },
        );
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {} },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(executeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: "SELECT * FROM test",
          parameters: [],
          warehouse_id: "test-warehouse-id",
        }),
        expect.any(AbortSignal),
      );
    });
  });
});
