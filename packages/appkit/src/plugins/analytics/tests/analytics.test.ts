import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  createTestPluginContext,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import {
  DateDay,
  Decimal,
  makeData,
  Table,
  TimestampMicrosecond,
  tableToIPC,
  Utf8,
  Vector,
  vectorFromArray,
} from "apache-arrow";
import type express from "express";
import { sql } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { AnalyticsPlugin, analytics, writeChunk } from "../analytics";
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
    test("should register the query and metric POST routes", () => {
      const plugin = new AnalyticsPlugin(config);
      const { router } = createMockRouter();

      plugin.injectRoutes(router);

      // Two POST routes: the SQL query route (asUser determined by the
      // .obo.sql file convention) and the metric-view route.
      expect(router.post).toHaveBeenCalledTimes(2);
      expect(router.post).toHaveBeenCalledWith(
        "/query/:query_key",
        expect.any(Function),
      );
      expect(router.post).toHaveBeenCalledWith(
        "/metric/:key",
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

    test("OBO requests differing only by whitespace in x-forwarded-user share one cache key", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM my_data",
        isAsUser: true,
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ owner: "alice-data" }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/query/:query_key");

      // Same user, but the forwarded header is padded with surrounding
      // whitespace. The OBO cache key derives from the trimmed user id
      // (executorKey = resolveUserId(req)), so this must hit the SAME cache
      // entry as the unpadded request below — no per-whitespace cache fork.
      const paddedReq = createMockRequest({
        params: { query_key: "my_data" },
        body: { parameters: {} },
        headers: {
          "x-forwarded-access-token": "alice-token",
          "x-forwarded-user": "  alice  ",
        },
      });
      const paddedRes = createMockResponse();
      await handler(paddedReq, paddedRes);

      // Same user, unpadded header — must reuse the cached result.
      const bareReq = createMockRequest({
        params: { query_key: "my_data" },
        body: { parameters: {} },
        headers: {
          "x-forwarded-access-token": "alice-token",
          "x-forwarded-user": "alice",
        },
      });
      const bareRes = createMockResponse();
      await handler(bareReq, bareRes);

      // Only one execution: the whitespace variant resolved to the same
      // per-user cache key as the bare id, so the second request was a hit.
      expect(executeMock).toHaveBeenCalledTimes(1);

      // Both responses serve the same (cached) data.
      expect(paddedRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"owner":"alice-data"'),
      );
      expect(bareRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"owner":"alice-data"'),
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

    test("/query/:query_key falls back ARROW_STREAM INLINE→EXTERNAL_LINKS and streams the preserved links in-context", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // INLINE rejected → EXTERNAL_LINKS. The result carries the pre-signed
      // `external_links` resolved in this request's context, so the route
      // streams them directly — no second getStatement under the ambient
      // service-principal context.
      const links = [{ external_link: "https://example.com/chunk-0" }];
      const executeMock = vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "INVALID_PARAMETER_VALUE: ARROW_STREAM not supported with INLINE disposition",
          ),
        )
        .mockResolvedValueOnce({
          result: {
            statement_id: "stmt-1",
            status: { state: "SUCCEEDED" },
            columnNames: ["group_key", "cost_usd"],
            external_links: links,
          },
        });
      (plugin as any).SQLClient.executeStatement = executeMock;

      const extBytes = new Uint8Array([9, 8, 7]);
      const streamExternalLinksMock = vi.fn(function* (_chunks: unknown) {
        yield extBytes;
      });
      (plugin as any).SQLClient.streamExternalLinks = streamExternalLinksMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // First call INLINE (rejected), second EXTERNAL_LINKS (fallback).
      expect(executeMock.mock.calls[0][1]).toMatchObject({
        disposition: "INLINE",
        format: "ARROW_STREAM",
      });
      expect(executeMock.mock.calls[1][1]).toMatchObject({
        disposition: "EXTERNAL_LINKS",
        format: "ARROW_STREAM",
      });
      // Streams the pre-signed links from the execute response (no re-fetch).
      expect(streamExternalLinksMock).toHaveBeenCalledTimes(1);
      expect(streamExternalLinksMock.mock.calls[0][0]).toBe(links);
      // Bytes stream on the response body with the Arrow content type — no
      // JSON error, no missingData throw.
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/vnd.apache.arrow.stream",
      );
      // Manifest names (from EXTERNAL_LINKS result) ride the header too.
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "X-Appkit-Arrow-Columns",
        encodeURIComponent(JSON.stringify(["group_key", "cost_usd"])),
      );
      expect(mockRes.json).not.toHaveBeenCalled();
      const written = (mockRes.write as any).mock.calls.map(
        (c: any[]) => c[0] as Buffer,
      );
      expect(written).toHaveLength(1);
      expect(Array.from(written[0])).toEqual([9, 8, 7]);
    });

    test("OBO: .obo.sql ARROW_STREAM external-links streams under the user context", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      // `.obo.sql` → isAsUser true → the route must run through asUser(req).
      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: true,
      });

      const links = [{ external_link: "https://example.com/obo-chunk-0" }];
      // Fake user-context executor: INLINE rejected, EXTERNAL_LINKS resolves
      // with the pre-signed links (resolved with the user's identity).
      const userExecutorQuery = vi.fn(async (_q, _p, fp) => {
        if (fp.disposition === "INLINE") {
          throw new Error(
            "INVALID_PARAMETER_VALUE: The format field must be JSON_ARRAY when the disposition field is INLINE.",
          );
        }
        return {
          external_links: links,
          columnNames: ["a"],
          statement_id: "obo-stmt",
        };
      });
      // Warehouse readiness must run through the user-context executor too, so
      // `getWorkspaceClient()` resolves to the user (not the SP) for `.obo.sql`.
      const ensureReadyMock = vi.fn().mockResolvedValue(undefined);
      const asUserSpy = vi.spyOn(plugin as any, "asUser").mockReturnValue({
        query: userExecutorQuery,
        _ensureArrowWarehouseReady: ensureReadyMock,
      });

      const streamExternalLinksMock = vi.fn(function* (_chunks: unknown) {
        yield new Uint8Array([1, 2, 3]);
      });
      (plugin as any).SQLClient.streamExternalLinks = streamExternalLinksMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
        // OBO requests carry the forwarded user identity; the arrow cache key
        // is scoped per user, so `resolveUserId` reads this header.
        headers: {
          "x-forwarded-user": "user@example.com",
          "x-forwarded-access-token": "user-token",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // The user context (asUser) executor ran the queries AND the warehouse
      // readiness — not the SP `this`.
      expect(asUserSpy).toHaveBeenCalledWith(mockReq);
      expect(userExecutorQuery).toHaveBeenCalled();
      expect(ensureReadyMock).toHaveBeenCalled();
      // The links the user-context executor resolved are streamed directly —
      // no re-fetch under a different identity.
      expect(streamExternalLinksMock).toHaveBeenCalledTimes(1);
      expect(streamExternalLinksMock.mock.calls[0][0]).toBe(links);
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/vnd.apache.arrow.stream",
      );
    });

    test("ARROW_STREAM: a stuck warehouse fails fast with a 503 WAREHOUSE_UNAVAILABLE", async () => {
      const plugin = new AnalyticsPlugin({
        ...config,
        arrowFirstByteTimeoutMs: 20,
      });
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });
      (plugin as any).SQLClient.ensureWarehouseRunning = vi
        .fn()
        .mockResolvedValue(undefined);
      // Warehouse never produces a first byte — only settles when aborted.
      (plugin as any).SQLClient.executeStatement = vi.fn(
        (_c: unknown, _i: unknown, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              ),
            );
          }),
      );

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "WAREHOUSE_UNAVAILABLE" }),
      );
    });

    test("ARROW_STREAM: a schema too wide for the header advertises a columns-ref instead", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });
      // 2000 columns → the encoded header value exceeds the size cap.
      const wideNames = Array.from({ length: 2000 }, (_, i) => `column_${i}`);
      (plugin as any).SQLClient.executeStatement = vi.fn().mockResolvedValue({
        result: {
          attachment: Buffer.from([1, 2, 3]).toString("base64"),
          columnNames: wideNames,
          statement_id: "stmt-wide",
        },
      });

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {}, format: "ARROW_STREAM" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      const setHeaderCalls = (mockRes.setHeader as any).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(setHeaderCalls).toContain("X-Appkit-Arrow-Columns-Ref");
      expect(setHeaderCalls).not.toContain("X-Appkit-Arrow-Columns");
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "X-Appkit-Arrow-Columns-Ref",
        "stmt-wide",
      );
    });

    test("GET /columns/:statementId returns the manifest column names", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();
      (plugin as any).SQLClient.getColumnNames = vi
        .fn()
        .mockResolvedValue(["name", "spend"]);

      plugin.injectRoutes(router);
      const handler = getHandler("GET", "/columns/:statementId");
      const mockReq = createMockRequest({
        params: { statementId: "stmt-wide" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({ columns: ["name", "spend"] });
    });

    test("GET /columns/:statementId falls back to the service principal when the user identity can't read it (OBO)", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      // User identity 404s (e.g. the statement was executed by the SP, which
      // the user can't `getStatement`); the SP `this` resolves it.
      const spGetColumns = vi.fn().mockResolvedValue(["a", "b"]);
      (plugin as any).SQLClient.getColumnNames = spGetColumns;
      const userGetColumnNames = vi
        .fn()
        .mockRejectedValue(new Error("RESOURCE_DOES_NOT_EXIST"));
      const asUserSpy = vi
        .spyOn(plugin as any, "asUser")
        .mockReturnValue({ _getColumnNames: userGetColumnNames });

      plugin.injectRoutes(router);
      const handler = getHandler("GET", "/columns/:statementId");
      const mockReq = createMockRequest({ params: { statementId: "stmt-x" } });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Tried the user identity first, then fell back to the service principal.
      expect(asUserSpy).toHaveBeenCalledWith(mockReq);
      expect(userGetColumnNames).toHaveBeenCalledWith("stmt-x");
      expect(spGetColumns).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ columns: ["a", "b"] });
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

    test("/query/:query_key does NOT fall back on a non-capability error (auth/SQL)", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // A genuine SQL/permission error carries no capability error code
      // (INVALID_PARAMETER_VALUE / NOT_IMPLEMENTED), so it must NOT trigger a
      // wasted EXTERNAL_LINKS attempt — it propagates as-is.
      const executeMock = vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Response from server (Bad Request) {"error_code":"TABLE_OR_VIEW_NOT_FOUND","message":"Table or view not found: foo"}',
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

      // The retry interceptor may attempt the query multiple times, but every
      // attempt stays on INLINE — a non-capability error never escalates to
      // EXTERNAL_LINKS.
      for (const call of executeMock.mock.calls) {
        expect(call[1]).toMatchObject({
          disposition: "INLINE",
          format: "ARROW_STREAM",
        });
      }
    });

    test("/query/:query_key falls back on a capability-coded rejection regardless of exact wording", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // A capability-coded rejection with wording we don't pattern-match
      // (Databricks could reword at any time). The errorCode gate alone must be
      // enough to escalate to EXTERNAL_LINKS — otherwise a message reword would
      // 500 every standard warehouse.
      const executeMock = vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            'Response from server (Bad Request) {"error_code":"INVALID_PARAMETER_VALUE","message":"this disposition/format combination is not available here"}',
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

      expect(executeMock).toHaveBeenCalledTimes(2);
      expect(executeMock.mock.calls[1][1]).toMatchObject({
        disposition: "EXTERNAL_LINKS",
        format: "ARROW_STREAM",
      });
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

    test("/query/:query_key streams ARROW_STREAM INLINE bytes directly on the response body (no SSE, no stash)", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      // Real base64 so the route can decode it via Buffer.from(..., "base64").
      // `columnNames` is what the connector attaches from the manifest (the
      // Arrow schema itself is positional col_N).
      const arrowBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const fakeAttachment = Buffer.from(arrowBytes).toString("base64");
      const executeMock = vi.fn().mockResolvedValue({
        result: {
          attachment: fakeAttachment,
          row_count: 1,
          columnNames: ["name", "totalSpend"],
        },
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

      // INLINE succeeded — a single execution, no EXTERNAL_LINKS fallback.
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock.mock.calls[0][1]).toMatchObject({
        disposition: "INLINE",
        format: "ARROW_STREAM",
      });

      // Bytes stream straight back on the response body with the Arrow
      // content type — no SSE frames, no stash, no JSON error.
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/vnd.apache.arrow.stream",
      );
      // Manifest column names ride a response header so the client can relabel
      // the positional Arrow schema.
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "X-Appkit-Arrow-Columns",
        encodeURIComponent(JSON.stringify(["name", "totalSpend"])),
      );
      expect(mockRes.json).not.toHaveBeenCalled();
      expect(mockRes.end).toHaveBeenCalled();

      const written = (mockRes.write as any).mock.calls.map(
        (c: any[]) => c[0] as Buffer,
      );
      expect(written).toHaveLength(1);
      expect(Buffer.isBuffer(written[0])).toBe(true);
      expect(Array.from(written[0])).toEqual(Array.from(arrowBytes));
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
      // Skip the leading warehouse_status event the route always emits;
      // the terminal result/arrow/error payload is the one under test.
      const payload = writeCalls.find(
        (s: string) =>
          s.startsWith("data: ") && !s.includes("warehouse_status"),
      );
      expect(payload).toBeDefined();
      expect(payload).toContain('"type":"result"');
      expect(payload).not.toContain('"type":"arrow"');
      // Real row values from the captured attachment: test_col=1, test_col2=2.
      // Integer columns are coerced to strings to match what JSON_ARRAY would
      // have produced for the same warehouse + same INT columns.
      expect(payload).toContain('"test_col":"1"');
      expect(payload).toContain('"test_col2":"2"');
    });

    test("/query/:query_key JSON_ARRAY fallback formats decimal, timestamp, date, and JSON-string columns to match the native JSON_ARRAY shape", async () => {
      // The server-side Arrow→rows decoder (needs-arrow fallback) must
      // render typed Arrow cells the same way the warehouse renders them
      // under native JSON_ARRAY, or callers can tell which path served the
      // query. Regression coverage for the four decode bugs:
      //  - DECIMAL: scale applied ("123.45"), not the raw unscaled mantissa.
      //  - TIMESTAMP: "yyyy-MM-dd HH:mm:ss[.SSS]", not a raw epoch number.
      //  - DATE: "yyyy-MM-dd", not a raw epoch number.
      //  - STRING holding JSON: parsed to an object, matching the JSON path.
      // Build a one-row Arrow table with each type and IPC-encode it.
      const decType = new Decimal(2, 10, 128); // scale=2, precision=10
      // 128-bit little-endian limbs for the signed unscaled value 12345.
      const decLimbs = new Uint32Array(4);
      decLimbs[0] = 12345;
      const decVec = new Vector([
        makeData({ type: decType, length: 1, data: decLimbs }),
      ]);
      const tsVec = vectorFromArray(
        [new Date(Date.UTC(2024, 5, 13, 1, 2, 3, 500))],
        new TimestampMicrosecond("UTC"),
      );
      // TIMESTAMP_NTZ: no timezone → ISO without the trailing Z.
      const tsNtzVec = vectorFromArray(
        [new Date(Date.UTC(2024, 0, 2, 3, 4, 5))],
        new TimestampMicrosecond(),
      );
      const dateVec = vectorFromArray(
        [new Date(Date.UTC(2024, 5, 13))],
        new DateDay(),
      );
      const jsonVec = vectorFromArray(['{"nested":1}'], new Utf8());
      const table = new Table({
        amount: decVec,
        ts: tsVec,
        ts_ntz: tsNtzVec,
        d: dateVec,
        meta: jsonVec,
      });
      const attachment = Buffer.from(tableToIPC(table, "stream")).toString(
        "base64",
      );

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
            'Response from server (Bad Request) {"error_code":"INVALID_PARAMETER_VALUE","message":"Inline disposition only supports ARROW_STREAM format."}',
          ),
        )
        .mockResolvedValueOnce({
          result: { attachment, status: { state: "SUCCEEDED" } },
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

      const writeCalls = (mockRes.write as any).mock.calls.map(
        (c: any[]) => c[0] as string,
      );
      const payload = writeCalls.find(
        (s: string) =>
          s.startsWith("data: ") && !s.includes("warehouse_status"),
      );
      expect(payload).toBeDefined();
      expect(payload).toContain('"type":"result"');
      // DECIMAL: scale applied, not the unscaled "12345".
      expect(payload).toContain('"amount":"123.45"');
      // TIMESTAMP: ISO-8601 ms precision with Z (zoned), not an epoch
      // number. Matches dogfood's native JSON_ARRAY rendering.
      expect(payload).toContain('"ts":"2024-06-13T01:02:03.500Z"');
      // TIMESTAMP_NTZ: same ISO form without the trailing Z.
      expect(payload).toContain('"ts_ntz":"2024-01-02T03:04:05.000"');
      // DATE: yyyy-MM-dd.
      expect(payload).toContain('"d":"2024-06-13"');
      // STRING holding JSON parsed to a nested object.
      expect(payload).toContain('"meta":{"nested":1}');
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
      // Skip the leading warehouse_status event the route always emits;
      // the terminal result/arrow/error payload is the one under test.
      const payload = writeCalls.find(
        (s: string) =>
          s.startsWith("data: ") && !s.includes("warehouse_status"),
      );
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

    test("emits warehouse_status events before the result for a STARTING warehouse", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ id: 1, name: "test" }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");

      // Override the default RUNNING mock with a STARTING -> RUNNING sequence
      // so the route streams a warehouse_status event before the result.
      const warehouseGet = vi
        .fn()
        .mockResolvedValueOnce({ state: "STARTING" })
        .mockResolvedValueOnce({ state: "RUNNING" });
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {} },
      });
      mockReq.serviceWorkspaceClient.warehouses.get = warehouseGet;
      mockReq.userWorkspaceClient.warehouses.get = warehouseGet;
      const mockRes = createMockResponse();

      // The connector polls every 3s between warehouse state checks; use fake
      // timers so the test doesn't actually sleep.
      vi.useFakeTimers();
      const handlerPromise = handler(mockReq, mockRes);
      await vi.runAllTimersAsync();
      await handlerPromise;
      vi.useRealTimers();

      // Inspect the SSE writes: a `warehouse_status` event must precede the
      // `result` event.
      const eventLines = (mockRes.write as any).mock.calls
        .map((call: any[]) => call[0] as string)
        .filter((s: string) => s.startsWith("event: "));
      const warehouseIdx = eventLines.findIndex(
        (s: string) => s === "event: warehouse_status\n",
      );
      const resultIdx = eventLines.findIndex(
        (s: string) => s === "event: result\n",
      );
      expect(warehouseIdx).toBeGreaterThanOrEqual(0);
      expect(resultIdx).toBeGreaterThanOrEqual(0);
      expect(warehouseIdx).toBeLessThan(resultIdx);

      // The status payload should include the state field.
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringMatching(
          /"type":"warehouse_status".*"state":"(STARTING|RUNNING)"/,
        ),
      );

      expect(executeMock).toHaveBeenCalledTimes(1);
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

  describe("writeChunk backpressure", () => {
    // A response stub that is always backpressured (`write` → false) and lets
    // the test fire lifecycle events. The shared `createMockResponse` returns a
    // truthy `write`, so it never exercises the backpressure branch.
    function backpressuredRes() {
      const listeners: Record<string, Array<() => void>> = {};
      return {
        write: vi.fn(() => false),
        once: vi.fn(function (this: unknown, ev: string, h: () => void) {
          listeners[ev] ??= [];
          listeners[ev].push(h);
          return this;
        }),
        off: vi.fn(function (this: unknown, ev: string, h: () => void) {
          if (listeners[ev]) {
            listeners[ev] = listeners[ev].filter((x) => x !== h);
          }
          return this;
        }),
        emit(ev: string) {
          for (const h of [...(listeners[ev] ?? [])]) h();
        },
        listenerCount(ev: string) {
          return (listeners[ev] ?? []).length;
        },
      };
    }

    test("resolves once the socket drains and detaches its listeners", async () => {
      const res = backpressuredRes();
      const pending = writeChunk(res as never, new Uint8Array([1, 2, 3]));
      res.emit("drain");
      await expect(pending).resolves.toBeUndefined();
      expect(res.listenerCount("drain")).toBe(0);
      expect(res.listenerCount("close")).toBe(0);
      expect(res.listenerCount("error")).toBe(0);
    });

    test("rejects (does not hang) when the client disconnects mid-backpressure", async () => {
      const res = backpressuredRes();
      const pending = writeChunk(res as never, new Uint8Array([1, 2, 3]));
      // The socket closes while backpressured — `drain` will never fire. If
      // writeChunk only awaited `drain`, this promise (and the stream feeding
      // it) would hang forever.
      res.emit("close");
      await expect(pending).rejects.toThrow();
      expect(res.listenerCount("drain")).toBe(0);
      expect(res.listenerCount("close")).toBe(0);
      expect(res.listenerCount("error")).toBe(0);
    });

    test("rejects up front if the socket is already closed when called", async () => {
      // Socket already destroyed before writeChunk runs: `close`/`error` have
      // already fired, so attaching listeners would never settle. The guard
      // must reject without writing or waiting.
      const res = {
        destroyed: true,
        writableEnded: false,
        write: vi.fn(() => false),
        once: vi.fn(),
        off: vi.fn(),
      };
      await expect(
        writeChunk(res as never, new Uint8Array([1, 2, 3])),
      ).rejects.toThrow();
      expect(res.write).not.toHaveBeenCalled();
      expect(res.once).not.toHaveBeenCalled();
    });
  });
});

describe("analytics as a cross-plugin tool provider", () => {
  // A consumer plugin (e.g. agents) resolves analytics' tools through the
  // shared PluginContext. These drive that dispatch and assert the on-behalf-of
  // identity the real executeTool resolves — coverage a bare stub can't give.
  test("dispatches analytics.query on behalf of the user", async () => {
    const rows = [{ customer: "Acme", revenue: 1_000_000 }];
    const mock = createTestPluginContext({
      analytics: { query: (args) => ({ rows, echoedArgs: args }) },
    });

    const req = createMockRequest({
      obo: { userId: "analyst@example.com" },
    }) as unknown as express.Request;
    const result = await mock.ctx.executeTool(req, "analytics", "query", {
      sql: "SELECT * FROM top_customers",
    });

    expect(result).toEqual({
      rows,
      echoedArgs: { sql: "SELECT * FROM top_customers" },
    });
    expect(mock.toolCalls).toHaveLength(1);
    expect(mock.toolCalls[0]).toMatchObject({
      plugin: "analytics",
      tool: "query",
      asUser: true,
      userId: "analyst@example.com",
    });
  });

  test("rejects a token-less request before the tool runs", async () => {
    const mock = createTestPluginContext({
      analytics: { query: () => ({ rows: [] }) },
    });
    const req = createMockRequest() as unknown as express.Request;

    await expect(
      mock.ctx.executeTool(req, "analytics", "query", {}),
    ).rejects.toThrow(/Missing user token/);
    expect(mock.toolCalls).toHaveLength(0);
  });

  test("forwards the per-call timeout so a slow tool is aborted", async () => {
    const mock = createTestPluginContext({
      analytics: {
        query: (_args, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted by timeout")),
            );
          }),
      },
    });
    const req = createMockRequest({ obo: true }) as unknown as express.Request;

    await expect(
      mock.ctx.executeTool(req, "analytics", "query", {}, undefined, 5),
    ).rejects.toThrow(/aborted by timeout/);
  });
});
