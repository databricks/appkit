import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { sql } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { AnalyticsPlugin, analytics } from "../analytics";
import { InlineArrowStash } from "../inline-arrow-stash";
import type { IAnalyticsConfig } from "../types";

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

vi.mock("../../../cache", () => ({
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
    test("should register single POST route for queries", () => {
      const plugin = new AnalyticsPlugin(config);
      const { router } = createMockRouter();

      plugin.injectRoutes(router);

      // Only 1 POST route - asUser is determined by .obo.sql file convention
      expect(router.post).toHaveBeenCalledTimes(1);
      expect(router.post).toHaveBeenCalledWith(
        "/query/:query_key",
        expect.any(Function),
      );
    });

    test("should register GET route for arrow results", () => {
      const plugin = new AnalyticsPlugin(config);
      const { router } = createMockRouter();

      plugin.injectRoutes(router);

      expect(router.get).toHaveBeenCalledTimes(1);
      expect(router.get).toHaveBeenCalledWith(
        "/arrow-result/:jobId",
        expect.any(Function),
      );
    });

    test("/arrow-result/inline-* drains the stash and serves bytes as application/vnd.apache.arrow.stream", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);

      const arrowBytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
      const { id } = (plugin as any).inlineArrowStash.put("global", arrowBytes);
      expect(id.startsWith("inline-")).toBe(true);

      const handler = getHandler("GET", "/arrow-result/:jobId");
      const mockReq = createMockRequest({ params: { jobId: id } });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/vnd.apache.arrow.stream",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Length",
        String(arrowBytes.length),
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Cache-Control",
        "no-store",
      );
      expect(mockRes.send).toHaveBeenCalledTimes(1);
      const sentBuf = (mockRes.send as any).mock.calls[0][0] as Buffer;
      expect(Buffer.isBuffer(sentBuf)).toBe(true);
      expect(Array.from(sentBuf)).toEqual(Array.from(arrowBytes));

      // Drain-on-read: a second fetch must return 410, not the bytes again.
      const secondRes = createMockResponse();
      await handler(mockReq, secondRes);
      expect(secondRes.status).toHaveBeenCalledWith(410);
    });

    test("/arrow-result/inline-* returns 410 when the stash entry never existed", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);

      const handler = getHandler("GET", "/arrow-result/:jobId");
      const mockReq = createMockRequest({
        params: { jobId: "inline-does-not-exist" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(410);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringMatching(/expired or unknown/),
        }),
      );
    });

    test("/arrow-result/inline-* returns 410 when the stash entry belongs to a different user", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);

      // Stash entry keyed to user-a, but the request resolves to "global"
      // (no x-forwarded-user header) — keys differ, take must return
      // nothing, and the entry stays put (single-user view).
      const bytes = new Uint8Array([1, 2, 3]);
      const { id } = (plugin as any).inlineArrowStash.put("user-a", bytes);

      const handler = getHandler("GET", "/arrow-result/:jobId");
      const mockReq = createMockRequest({ params: { jobId: id } });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(410);
      // The entry must still be there for the real owner.
      expect((plugin as any).inlineArrowStash.take(id, "user-a")).toBeDefined();
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

    test("/query/:query_key should execute as service principal for .sql files (isAsUser: false)", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      // Mock getAppQuery to return a regular .sql file (isAsUser: false)
      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      let capturedWorkspaceClient: any;
      const executeMock = vi
        .fn()
        .mockImplementation((workspaceClient, ..._args) => {
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

      // Verify service workspace client is used
      expect(capturedWorkspaceClient).toBeDefined();

      // Verify executeStatement is called with correct statement
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
        "text/event-stream; charset=utf-8",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Cache-Control",
        "no-cache, no-transform",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith("X-Accel-Buffering", "no");

      expect(mockRes.write).toHaveBeenCalledWith("event: result\n");
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"data":[{"id":1,"name":"test"}]'),
      );

      expect(mockRes.end).toHaveBeenCalled();
    });

    test("/query/:query_key should execute as user for .obo.sql files (isAsUser: true)", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      // Mock getAppQuery to return an .obo.sql file (isAsUser: true)
      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM users WHERE id = :user_id",
        isAsUser: true,
      });

      let capturedWorkspaceClient: any;
      const executeMock = vi
        .fn()
        .mockImplementation((workspaceClient, ..._args: any[]) => {
          capturedWorkspaceClient = workspaceClient;
          return Promise.resolve({
            result: { data: [{ user_id: 123, name: "Alice" }] },
          });
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      // Request with user headers for .obo.sql queries
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

      // Verify a workspace client is used
      expect(capturedWorkspaceClient).toBeDefined();

      // Verify the query is executed with correct statement
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
        "text/event-stream; charset=utf-8",
      );

      expect(mockRes.write).toHaveBeenCalledWith("event: result\n");
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"user_id":123'),
      );

      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should use different cache keys for .sql vs .obo.sql queries", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const getAppQueryMock = vi.fn();
      (plugin as any).app.getAppQuery = getAppQueryMock;

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ id: 1 }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/query/:query_key");

      // First request: .sql file (isAsUser: false)
      getAppQueryMock.mockResolvedValueOnce({
        query: "SELECT 1",
        isAsUser: false,
      });

      const mockReq1 = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {} },
      });
      const mockRes1 = createMockResponse();
      await handler(mockReq1, mockRes1);

      // Second request: .obo.sql file (isAsUser: true)
      getAppQueryMock.mockResolvedValueOnce({
        query: "SELECT 1",
        isAsUser: true,
      });

      const mockReq2 = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {} },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes2 = createMockResponse();
      await handler(mockReq2, mockRes2);

      // Both should execute (different cache keys due to isAsUser)
      expect(executeMock).toHaveBeenCalledTimes(2);
    });

    test("should return cached result on second request for .sql files", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test WHERE foo = :foo",
        isAsUser: false,
      });

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

    test("should share cache across users for .sql files (global cache)", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      // Mock returns .sql file (isAsUser: false) - should use global cache
      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM shared_data",
        isAsUser: false,
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ id: 1, name: "shared" }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");

      // User 1's request
      const mockReq1 = createMockRequest({
        params: { query_key: "shared_query" },
        body: { parameters: {} },
        headers: {
          "x-forwarded-access-token": "user-token-1",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes1 = createMockResponse();
      await handler(mockReq1, mockRes1);

      // User 2's request - different user, but should use shared cache
      const mockReq2 = createMockRequest({
        params: { query_key: "shared_query" },
        body: { parameters: {} },
        headers: {
          "x-forwarded-access-token": "user-token-2",
          "x-forwarded-user": "user-2",
        },
      });
      const mockRes2 = createMockResponse();
      await handler(mockReq2, mockRes2);

      // User 3's request - also should use shared cache
      const mockReq3 = createMockRequest({
        params: { query_key: "shared_query" },
        body: { parameters: {} },
        headers: {
          "x-forwarded-access-token": "user-token-3",
          "x-forwarded-user": "user-3",
        },
      });
      const mockRes3 = createMockResponse();
      await handler(mockReq3, mockRes3);

      // Only 1 execution - cache is shared across all users for .sql files
      expect(executeMock).toHaveBeenCalledTimes(1);

      // All users get the same cached result
      expect(mockRes1.write).toHaveBeenCalledWith(
        expect.stringContaining('"name":"shared"'),
      );
      expect(mockRes2.write).toHaveBeenCalledWith(
        expect.stringContaining('"name":"shared"'),
      );
      expect(mockRes3.write).toHaveBeenCalledWith(
        expect.stringContaining('"name":"shared"'),
      );
    });

    test("should cache user-scoped .obo.sql queries separately per user", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      // Mock returns .obo.sql file (isAsUser: true)
      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM users WHERE id = :user_id",
        isAsUser: true,
      });

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

      const handler = getHandler("POST", "/query/:query_key");

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

    test("OBO cache key must use the end user's ID, not the service principal's", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM my_data",
        isAsUser: true,
      });

      const executeMock = vi
        .fn()
        .mockResolvedValueOnce({
          result: { data: [{ owner: "alice-data" }] },
        })
        .mockResolvedValueOnce({
          result: { data: [{ owner: "bob-data" }] },
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/query/:query_key");

      // User Alice makes an OBO query
      const aliceReq = createMockRequest({
        params: { query_key: "my_data" },
        body: { parameters: {} },
        headers: {
          "x-forwarded-access-token": "alice-token",
          "x-forwarded-user": "alice",
        },
      });
      const aliceRes = createMockResponse();
      await handler(aliceReq, aliceRes);

      // User Bob makes the SAME OBO query with the SAME parameters
      const bobReq = createMockRequest({
        params: { query_key: "my_data" },
        body: { parameters: {} },
        headers: {
          "x-forwarded-access-token": "bob-token",
          "x-forwarded-user": "bob",
        },
      });
      const bobRes = createMockResponse();
      await handler(bobReq, bobRes);

      // Both queries must execute — different users must not share OBO cache
      expect(executeMock).toHaveBeenCalledTimes(2);

      // Alice sees her own data
      expect(aliceRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"owner":"alice-data"'),
      );
      // Bob sees his own data, NOT Alice's cached result
      expect(bobRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"owner":"bob-data"'),
      );
    });

    test("should handle AbortSignal cancellation", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

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

    test("/query/:query_key should pass INLINE + ARROW_STREAM format parameters when format is ARROW_STREAM", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ id: 1 }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(executeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: "SELECT * FROM test",
          warehouse_id: "test-warehouse-id",
          disposition: "INLINE",
          format: "ARROW_STREAM",
        }),
        expect.any(AbortSignal),
      );
    });

    test("/query/:query_key should use INLINE + JSON_ARRAY by default when no format specified", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ id: 1 }] },
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

      expect(executeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          disposition: "INLINE",
          format: "JSON_ARRAY",
        }),
        expect.any(AbortSignal),
      );
    });

    test("/query/:query_key should pass INLINE + JSON_ARRAY when format is explicitly JSON_ARRAY", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ id: 1 }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "JSON_ARRAY" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(executeMock.mock.calls[0][1]).toMatchObject({
        disposition: "INLINE",
        format: "JSON_ARRAY",
      });
    });

    test("/query/:query_key should fall back ARROW_STREAM from INLINE to EXTERNAL_LINKS when warehouse rejects INLINE", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const executeMock = vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "INVALID_PARAMETER_VALUE: ARROW_STREAM not supported with INLINE disposition",
          ),
        )
        .mockResolvedValueOnce({
          result: { statement_id: "stmt-1", status: { state: "SUCCEEDED" } },
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // First call: INLINE (rejected)
      expect(executeMock.mock.calls[0][1]).toMatchObject({
        disposition: "INLINE",
        format: "ARROW_STREAM",
      });
      // Second call: EXTERNAL_LINKS (fallback)
      expect(executeMock.mock.calls[1][1]).toMatchObject({
        disposition: "EXTERNAL_LINKS",
        format: "ARROW_STREAM",
      });
    });

    test("/query/:query_key falls back on a structured ExecutionError.errorCode without scanning the message", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // Properly-structured ExecutionError, as the connector now produces
      // when the SDK's ApiError surfaces with errorCode set.
      const { ExecutionError } = await import("../../../errors/execution");
      const structuredError = ExecutionError.statementFailed(
        "ARROW_STREAM is not supported with INLINE disposition",
        "INVALID_PARAMETER_VALUE",
      );

      const executeMock = vi
        .fn()
        .mockRejectedValueOnce(structuredError)
        .mockResolvedValueOnce({
          result: { statement_id: "stmt-1", status: { state: "SUCCEEDED" } },
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Both attempts: INLINE (rejected via structured code) → EXTERNAL_LINKS.
      expect(executeMock).toHaveBeenCalledTimes(2);
      expect(executeMock.mock.calls[1][1]).toMatchObject({
        disposition: "EXTERNAL_LINKS",
        format: "ARROW_STREAM",
      });
    });

    test("/query/:query_key falls back when error message carries a structured INVALID_PARAMETER_VALUE error_code", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // Wrapped JSON error like the SDK surfaces from a `Bad Request` HTTP
      // response. Both INLINE and ARROW_STREAM appear, plus the structured code.
      const wrappedJsonError = new Error(
        'Response from server (Bad Request) {"error_code":"INVALID_PARAMETER_VALUE","message":"ARROW_STREAM is not supported with INLINE disposition on this warehouse"}',
      );
      const executeMock = vi
        .fn()
        .mockRejectedValueOnce(wrappedJsonError)
        .mockResolvedValueOnce({
          result: { statement_id: "stmt-1", status: { state: "SUCCEEDED" } },
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Both attempts ran: INLINE (rejected) then EXTERNAL_LINKS (succeeded).
      expect(executeMock).toHaveBeenCalledTimes(2);
      expect(executeMock.mock.calls[1][1]).toMatchObject({
        disposition: "EXTERNAL_LINKS",
        format: "ARROW_STREAM",
      });
    });

    test("/query/:query_key does NOT fall back when only one of INLINE/ARROW_STREAM appears in the error", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // Realistic non-format error that mentions just one of the keywords —
      // e.g. an unrelated INVALID_PARAMETER_VALUE about a different param.
      const executeMock = vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Response from server (Bad Request) {"error_code":"INVALID_PARAMETER_VALUE","message":"INLINE is not a valid value for parameter `mode`"}',
          ),
        );
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // The retry interceptor may attempt the query multiple times, but the
      // analytics plugin must never escalate to EXTERNAL_LINKS for an error
      // that doesn't actually indicate a format/disposition rejection.
      for (const call of executeMock.mock.calls) {
        expect(call[1]).toMatchObject({
          disposition: "INLINE",
          format: "ARROW_STREAM",
        });
      }
    });

    test("/query/:query_key should not fall back for non-format errors", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const executeMock = vi
        .fn()
        .mockRejectedValue(new Error("PERMISSION_DENIED: no access"));
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Only one call — non-format error is not retried with different disposition.
      for (const call of executeMock.mock.calls) {
        expect(call[1]).toMatchObject({
          disposition: "INLINE",
          format: "ARROW_STREAM",
        });
      }
    });

    test("/query/:query_key stashes ARROW_STREAM INLINE bytes and emits an arrow message with a synthetic inline- id", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // Real base64 so the route can decode it via Buffer.from(..., "base64").
      const arrowBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const fakeAttachment = Buffer.from(arrowBytes).toString("base64");
      const executeMock = vi.fn().mockResolvedValue({
        result: { attachment: fakeAttachment, row_count: 1 },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // The route should not fall back to EXTERNAL_LINKS — INLINE succeeded.
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock.mock.calls[0][1]).toMatchObject({
        disposition: "INLINE",
        format: "ARROW_STREAM",
      });
      // SSE payload: unified `arrow` message with an inline- prefixed id.
      // The base64 attachment must NOT appear on the SSE channel.
      const writeCalls = (mockRes.write as any).mock.calls.map(
        (c: any[]) => c[0] as string,
      );
      const payload = writeCalls.find((s: string) => s.startsWith("data: "));
      expect(payload).toBeDefined();
      expect(payload).toContain('"type":"arrow"');
      expect(payload).toMatch(/"statement_id":"inline-[^"]+"/);
      expect(payload).not.toContain("arrow_inline");
      expect(payload).not.toContain(fakeAttachment);

      // The decoded bytes should be in the stash, keyed by the same
      // synthetic id; a subsequent /arrow-result fetch will drain them.
      const idMatch = payload?.match(/"statement_id":"(inline-[^"]+)"/);
      expect(idMatch).not.toBeNull();
      const inlineId = idMatch?.[1];
      const stashed = (plugin as any).inlineArrowStash.take(inlineId, "global");
      expect(stashed).toBeDefined();
      expect(Array.from(stashed)).toEqual(Array.from(arrowBytes));
    });

    test("/query/:query_key spills the already-decoded bytes into the stash overflow pool when the regular pool is full — single execution, no double-billing", async () => {
      // The regular stash put may refuse new entries when at cap. We must
      // NOT respond by re-executing the same statement with EXTERNAL_LINKS:
      // the warehouse has already been billed, the bytes are already
      // decoded server-side, and a second execution can return a divergent
      // result for non-deterministic SQL (CURRENT_TIMESTAMP, RAND, late
      // rows). The stash's overflow pool absorbs the bytes so the client
      // still gets an inline- id pointing at the original result.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const fakeAttachment = Buffer.from(new Uint8Array([1, 2, 3])).toString(
        "base64",
      );
      const executeMock = vi.fn().mockResolvedValueOnce({
        result: { attachment: fakeAttachment, row_count: 1 },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      // Force the regular pool to be at cap so the put spills into overflow.
      // We construct a tiny stash and pre-fill the regular pool.
      const tinyStash = new InlineArrowStash({
        maxBytes: 4,
        maxOverflowBytes: 64,
      });
      tinyStash.put("filler", new Uint8Array([9, 9, 9, 9]));
      (plugin as any).inlineArrowStash = tinyStash;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Single execution: no EXTERNAL_LINKS retry.
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock.mock.calls[0][1]).toMatchObject({
        disposition: "INLINE",
        format: "ARROW_STREAM",
      });

      // SSE payload carries an inline- id pointing at the overflow entry.
      const writeCalls = (mockRes.write as any).mock.calls.map(
        (c: any[]) => c[0] as string,
      );
      const payload = writeCalls.find((s: string) => s.startsWith("data: "));
      expect(payload).toBeDefined();
      expect(payload).toContain('"type":"arrow"');
      expect(payload).toMatch(/"statement_id":"inline-[^"]+"/);

      // Bytes landed in the overflow pool, regular pool size unchanged.
      expect(tinyStash.overflowSize()).toBe(3);
      expect(tinyStash.size()).toBe(4);
    });

    test("/query/:query_key surfaces a stable error when both regular and overflow pools are exhausted — never silently double-bills", async () => {
      // When even the overflow pool cannot fit the payload, the route
      // surfaces INLINE_ARROW_STASH_EXHAUSTED instead of re-running the
      // statement on EXTERNAL_LINKS. The previous behavior (silent retry)
      // double-billed the warehouse and could return divergent results.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const fakeAttachment = Buffer.from(new Uint8Array([1, 2, 3])).toString(
        "base64",
      );
      const executeMock = vi.fn().mockResolvedValueOnce({
        result: { attachment: fakeAttachment, row_count: 1 },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      // Force both put paths to refuse: spy returns null unconditionally.
      vi.spyOn((plugin as any).inlineArrowStash, "put").mockReturnValue(null);

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Single execution: never re-runs on EXTERNAL_LINKS.
      expect(executeMock).toHaveBeenCalledTimes(1);

      // SSE error payload carries the stable errorCode for UI branching.
      // The writer emits separate lines (`id:`, `event: error`, `data: ...`)
      // — join them so we can match across the framing.
      const writeCalls = (mockRes.write as any).mock.calls.map(
        (c: any[]) => c[0] as string,
      );
      const errorFrame = writeCalls
        .filter((s: string) => s.startsWith("data: "))
        .join("\n");
      expect(errorFrame).toContain("INLINE_ARROW_STASH_EXHAUSTED");
      // Client-safe message reaches the wire; raw upstream text does not.
      expect(errorFrame).toContain("Server is at capacity");
      expect(errorFrame).not.toContain("Inline Arrow stash exhausted");
    });

    test("/query/:query_key falls back JSON_ARRAY to ARROW_STREAM INLINE when warehouse refuses JSON_ARRAY for INLINE", async () => {
      // Some serverless warehouses (the ones this PR is centrally aimed at)
      // only accept ARROW_STREAM for INLINE results — JSON_ARRAY + INLINE is
      // rejected outright. The caller still asked for JSON_ARRAY, so the
      // server retries as ARROW_STREAM + INLINE and decodes the attachment
      // back into plain row objects: the caller's contract is preserved and
      // the SSE channel still carries a `result` message, not an `arrow`
      // message.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // Real base64 Arrow IPC captured from a serverless warehouse running
      // `SELECT 1 AS test_col, 2 AS test_col2` (one row, two INT columns).
      const REAL_ARROW_ATTACHMENT =
        "/////7gAAAAQAAAAAAAKAAwACgAJAAQACgAAABAAAAAAAQQACAAIAAAABAAIAAAABAAAAAIAAABMAAAABAAAAMz///8QAAAAGAAAAAAAAQIUAAAAvP///yAAAAAAAAABAAAAAAkAAAB0ZXN0X2NvbDIAAAAQABQAEAAOAA8ABAAAAAgAEAAAABgAAAAgAAAAAAABAhwAAAAIAAwABAALAAgAAAAgAAAAAAAAAQAAAAAIAAAAdGVzdF9jb2wAAAAA/////7gAAAAQAAAADAAaABgAFwAEAAgADAAAACAAAAAAAQAAAAAAAAAAAAAAAAADBAAKABgADAAIAAQACgAAADwAAAAQAAAAAQAAAAAAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAEAAAAAAAAAQAAAAAAAAAAEAAAAAAAAAIAAAAAAAAAAAQAAAAAAAADAAAAAAAAAAAQAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP////8AAAAA";

      const executeMock = vi
        .fn()
        // First call: JSON_ARRAY + INLINE — warehouse rejects.
        .mockRejectedValueOnce(
          new Error(
            'Response from server (Bad Request) {"error_code":"INVALID_PARAMETER_VALUE","message":"Inline disposition only supports ARROW_STREAM format."}',
          ),
        )
        // Second call: ARROW_STREAM + INLINE — warehouse returns the bytes.
        .mockResolvedValueOnce({
          result: {
            attachment: REAL_ARROW_ATTACHMENT,
            status: { state: "SUCCEEDED" },
          },
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "JSON_ARRAY" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Two calls: first JSON_ARRAY + INLINE (rejected), then the fallback
      // ARROW_STREAM + INLINE (the warehouse's preferred shape for INLINE).
      expect(executeMock).toHaveBeenCalledTimes(2);
      expect(executeMock.mock.calls[0][1]).toMatchObject({
        disposition: "INLINE",
        format: "JSON_ARRAY",
      });
      expect(executeMock.mock.calls[1][1]).toMatchObject({
        disposition: "INLINE",
        format: "ARROW_STREAM",
      });

      // The SSE wire payload must look like a JSON_ARRAY result, not an
      // arrow message — the caller asked for JSON_ARRAY and the server has
      // already decoded Arrow → rows.
      const writeCalls = (mockRes.write as any).mock.calls.map(
        (c: any[]) => c[0] as string,
      );
      const payload = writeCalls.find((s: string) => s.startsWith("data: "));
      expect(payload).toBeDefined();
      expect(payload).toContain('"type":"result"');
      expect(payload).not.toContain('"type":"arrow"');
      // Real row values from the captured attachment: test_col=1, test_col2=2.
      // Integer columns are coerced to strings to match what JSON_ARRAY would
      // have produced for the same warehouse + same INT columns.
      expect(payload).toContain('"test_col":"1"');
      expect(payload).toContain('"test_col2":"2"');
    });

    test("/query/:query_key surfaces an error when both JSON_ARRAY + INLINE and the ARROW_STREAM retry fail", async () => {
      // If the JSON_ARRAY retry path (ARROW_STREAM + INLINE) also fails — e.g.
      // a downstream warehouse outage that affects both shapes — the route
      // must surface the failure rather than silently dropping it.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // First mocked call (JSON_ARRAY + INLINE) rejects with a needs-arrow
      // signal; every subsequent call rejects with an unrelated failure. The
      // retry interceptor may retry the second call multiple times — we only
      // care that the retry path was taken and that the request ultimately
      // surfaces an error rather than a successful result.
      const executeMock = vi.fn().mockImplementation((_wc, opts) => {
        if (opts?.disposition === "INLINE" && opts?.format === "JSON_ARRAY") {
          return Promise.reject(
            new Error(
              'Response from server (Bad Request) {"error_code":"INVALID_PARAMETER_VALUE","message":"Inline disposition only supports ARROW_STREAM format."}',
            ),
          );
        }
        return Promise.reject(new Error("warehouse is down"));
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "JSON_ARRAY" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // The retry happened: at least one ARROW_STREAM + INLINE call followed
      // the initial JSON_ARRAY + INLINE rejection.
      const formats = executeMock.mock.calls.map((c: any[]) => c[1]);
      expect(
        formats.some(
          (f: any) => f?.disposition === "INLINE" && f?.format === "JSON_ARRAY",
        ),
      ).toBe(true);
      expect(
        formats.some(
          (f: any) =>
            f?.disposition === "INLINE" && f?.format === "ARROW_STREAM",
        ),
      ).toBe(true);
      // No call should escalate to EXTERNAL_LINKS — that fallback only
      // exists on the ARROW_STREAM caller path.
      expect(
        formats.some((f: any) => f?.disposition === "EXTERNAL_LINKS"),
      ).toBe(false);

      // The SSE payload, if any was written, must NOT carry a successful
      // result frame.
      const writeCalls = (mockRes.write as any).mock.calls.map(
        (c: any[]) => c[0] as string,
      );
      const payload = writeCalls.find((s: string) => s.startsWith("data: "));
      if (payload) {
        expect(payload).not.toContain('"type":"result"');
      }
    });

    test("/query/:query_key rejects unknown format values with 400", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      // "CSV" is genuinely unsupported. The legacy spellings "JSON" / "ARROW"
      // are *accepted* by the route (normalized to JSON_ARRAY / ARROW_STREAM
      // for back-compat with appkit < 0.33.0), so they must not be used here.
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "CSV" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(executeMock).not.toHaveBeenCalled();
    });

    test("/query/:query_key does not retry the fallback when the request was aborted", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const executeMock = vi.fn().mockImplementation((_wc, _opts, signal) => {
        // Simulate a signal that becomes aborted before the failure surfaces —
        // e.g. the client cancelled the SSE stream mid-query. Use vitest's
        // getter spy rather than Object.defineProperty so we don't try to
        // override the native non-configurable AbortSignal.aborted getter.
        if (signal) {
          vi.spyOn(signal, "aborted", "get").mockReturnValue(true);
        }
        return Promise.reject(
          new Error(
            "INVALID_PARAMETER_VALUE: ARROW_STREAM not supported with INLINE disposition",
          ),
        );
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Even though the error message would normally trigger fallback, the
      // aborted signal should short-circuit and prevent a second statement.
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    test("/query/:query_key does NOT fall back JSON_ARRAY when the rejection lacks a needs-arrow signal", async () => {
      // A generic INVALID_PARAMETER_VALUE that doesn't mention the INLINE
      // disposition could be any unrelated SQL/permission error. The classifier
      // must NOT interpret it as "warehouse wants ARROW_STREAM" — falling back
      // would mask the real failure.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const executeMock = vi
        .fn()
        .mockRejectedValue(
          new Error("INVALID_PARAMETER_VALUE: only supports ARROW_STREAM"),
        );
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "JSON_ARRAY" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // All calls stay on JSON_ARRAY + INLINE — no retry path with a different
      // disposition or format was taken.
      for (const call of executeMock.mock.calls) {
        expect(call[1]).toMatchObject({
          disposition: "INLINE",
          format: "JSON_ARRAY",
        });
      }
    });

    test("should return 404 when query file is not found", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      // Mock getAppQuery to return null (query not found)
      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue(null);

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "nonexistent_query" },
        body: { parameters: {} },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Query not found",
      });
    });
  });

  describe("toolkit()", () => {
    test("produces ToolkitEntry records keyed by the plugin name", () => {
      const plugin = new AnalyticsPlugin({ name: "analytics" });
      const entries = plugin.toolkit();
      expect(Object.keys(entries)).toContain("analytics.query");
      const entry = entries["analytics.query"];
      expect(entry.__toolkitRef).toBe(true);
      expect(entry.pluginName).toBe("analytics");
      expect(entry.localName).toBe("query");
    });

    test("respects prefix and only options", () => {
      const plugin = new AnalyticsPlugin({ name: "analytics" });
      const entries = plugin.toolkit({ prefix: "", only: ["query"] });
      expect(Object.keys(entries)).toEqual(["query"]);
    });
  });
});
