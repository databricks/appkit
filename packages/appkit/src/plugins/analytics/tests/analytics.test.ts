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

    test("/query/:query_key should return canonical 400 when format is invalid", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      (plugin as any).app.getAppQuery = vi.fn();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { format: 123 },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
          requestId: expect.any(String),
        }),
      );
      // Handler body (SQL execution) should never be reached.
      expect(executeMock).not.toHaveBeenCalled();
      expect((plugin as any).app.getAppQuery).not.toHaveBeenCalled();
    });

    test("/query/:query_key should return canonical 400 when format is unknown string", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      (plugin as any).app.getAppQuery = vi.fn();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { format: "PARQUET" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        }),
      );
      expect(executeMock).not.toHaveBeenCalled();
    });

    test("/query/:query_key should return canonical 400 when parameters has more than 100 keys", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      (plugin as any).app.getAppQuery = vi.fn();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const oversizedParams: Record<string, string> = {};
      for (let i = 0; i < 101; i++) {
        oversizedParams[`p${i}`] = String(i);
      }
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: oversizedParams },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        }),
      );
      expect(executeMock).not.toHaveBeenCalled();
      expect((plugin as any).app.getAppQuery).not.toHaveBeenCalled();
    });

    test("/query/:query_key should return canonical 400 when a parameter value is an array", async () => {
      // The body schema restricts parameter values to SQLTypeMarker
      // objects or `null`. Arrays are neither, so they have to be
      // rejected at the HTTP boundary; otherwise oversized nested
      // payloads would reach the query processor.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      (plugin as any).app.getAppQuery = vi.fn();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: { key: ["array", "value"] } },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        }),
      );
      expect(executeMock).not.toHaveBeenCalled();
      expect((plugin as any).app.getAppQuery).not.toHaveBeenCalled();
    });

    test("/query/:query_key should accept SQLTypeMarker values in parameters", async () => {
      // The body schema accepts SQLTypeMarker objects (sql.string(),
      // sql.number(), etc.) at value position; the handler must run,
      // the marker must pass through to the query processor, and the
      // SQL parameter list must reflect the marker's type.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM users WHERE id = :user_id",
        isAsUser: false,
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ id: 5 }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "user_lookup" },
        body: { parameters: { user_id: sql.number(5) } },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Handler reaches SQL execution — marker passes through validation.
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: "SELECT * FROM users WHERE id = :user_id",
          parameters: expect.arrayContaining([
            expect.objectContaining({
              name: "user_id",
              value: "5",
              type: "NUMERIC",
            }),
          ]),
        }),
        expect.any(AbortSignal),
      );
    });

    test("/query/:query_key should return canonical 400 for malformed marker (unknown __sql_type)", async () => {
      // Markers with an unknown discriminant value must be rejected by
      // the schema. The handler body must never run.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      (plugin as any).app.getAppQuery = vi.fn();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: {
          parameters: { user_id: { __sql_type: "NOT_A_TYPE", value: "5" } },
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        }),
      );
      expect(executeMock).not.toHaveBeenCalled();
      expect((plugin as any).app.getAppQuery).not.toHaveBeenCalled();
    });

    test("/query/:query_key should return canonical 400 for marker with extra unknown field", async () => {
      // The marker schema is `.strict()` — unknown fields must be
      // rejected so callers can't smuggle additional keys past
      // validation.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      (plugin as any).app.getAppQuery = vi.fn();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: {
          parameters: {
            user_id: { __sql_type: "STRING", value: "x", evil: true },
          },
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        }),
      );
      expect(executeMock).not.toHaveBeenCalled();
      expect((plugin as any).app.getAppQuery).not.toHaveBeenCalled();
    });

    test("/query/:query_key should return canonical 400 for oversized marker value", async () => {
      // Marker `value` is capped at 4096 characters. Oversized payloads
      // must be rejected at the HTTP boundary before the query processor
      // ever sees them.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      (plugin as any).app.getAppQuery = vi.fn();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: {
          parameters: {
            big: { __sql_type: "STRING", value: "a".repeat(4097) },
          },
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        }),
      );
      expect(executeMock).not.toHaveBeenCalled();
      expect((plugin as any).app.getAppQuery).not.toHaveBeenCalled();
    });

    test("/query/:query_key should reject raw primitive values in parameters", async () => {
      // Raw JSON primitives (string, number, boolean) are rejected at the
      // HTTP boundary so the handler never starts SSE streaming with
      // values the query processor would later refuse. Callers must wrap
      // primitives with `sql.string()`, `sql.number()`, etc.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      (plugin as any).app.getAppQuery = vi.fn();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: {
          parameters: {
            str: "hello",
            num: 42,
            bool: true,
          },
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        }),
      );
      expect(executeMock).not.toHaveBeenCalled();
      expect((plugin as any).app.getAppQuery).not.toHaveBeenCalled();
    });

    test("/query/:query_key should reject a raw number parameter", async () => {
      // Specific regression for the late-failure-via-SSE concern: a raw
      // number (not a marker) must produce VALIDATION_ERROR before the
      // handler dispatches to executeStream.
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      const executeMock = vi.fn();
      (plugin as any).SQLClient.executeStatement = executeMock;
      (plugin as any).app.getAppQuery = vi.fn();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: { user_id: 123 } },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        }),
      );
      expect(executeMock).not.toHaveBeenCalled();
      expect((plugin as any).app.getAppQuery).not.toHaveBeenCalled();
    });

    test("/query/:query_key should accept null parameter values", async () => {
      // `null` is the only non-marker value that passes the schema —
      // the query processor's `_createParameter` returns null for null
      // entries (effectively skipping them).
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT 1",
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
        body: { parameters: { nullish: null } },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Validation lets the request through; the handler runs and tries
      // to dispatch to executeStream.
      expect((plugin as any).app.getAppQuery).toHaveBeenCalledTimes(1);
    });

    test("/query/:query_key should apply format default of JSON when omitted", async () => {
      const plugin = new AnalyticsPlugin(config);
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT 1",
        isAsUser: false,
      });

      const executeMock = vi.fn().mockResolvedValue({
        result: { data: [{ id: 1 }] },
      });
      (plugin as any).SQLClient.executeStatement = executeMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      // No `format` field — schema should default it to "JSON"
      // (i.e. no formatParameters are passed to executeStatement).
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {} },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(executeMock).toHaveBeenCalledTimes(1);
      // JSON format should NOT set a disposition/format ARROW_STREAM.
      const call = executeMock.mock.calls[0][1];
      expect(call).not.toHaveProperty("disposition");
      expect(call).not.toHaveProperty("format");
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
        "text/event-stream",
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
});
