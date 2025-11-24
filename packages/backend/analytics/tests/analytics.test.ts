import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  setupDatabricksEnv,
  runWithRequestContext,
} from "@tools/test-helpers";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AnalyticsPlugin, analytics } from "../src/analytics";
import type { IAnalyticsConfig } from "../src/types";

describe("Analytics Plugin", () => {
  let config: IAnalyticsConfig;

  beforeEach(() => {
    config = { timeout: 5000 };
    setupDatabricksEnv();
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

      await runWithRequestContext(async () => {
        await handler(mockReq, mockRes);
      });

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

      const mockServiceClient = { service: "client" };
      await runWithRequestContext(
        async () => {
          await handler(mockReq, mockRes);
        },
        {
          serviceDatabricksClient: mockServiceClient as any,
        },
      );

      // Verify service workspace client is used
      expect(capturedWorkspaceClient).toBe(mockServiceClient);

      // Verify executeStatement is called with service workspace client
      expect(executeMock).toHaveBeenCalledWith(
        mockServiceClient,
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
      const mockReq = createMockRequest({
        params: { query_key: "user_profile" },
        body: { parameters: { user_id: 123 } },
        headers: { "x-forwarded-access-token": "user-token-123" },
      });
      const mockRes = createMockResponse();

      const mockUserClient = { user: "client" };
      await runWithRequestContext(
        async () => {
          await handler(mockReq, mockRes);
        },
        {
          userDatabricksClient: mockUserClient as any,
          userName: "user-token-123",
        },
      );

      // Verify user workspace client is used
      expect(capturedWorkspaceClient).toBe(mockUserClient);

      // Verify the user workspace client is passed to SQL connector
      expect(executeMock).toHaveBeenCalledWith(
        mockUserClient,
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
        body: { parameters: { foo: "bar" } },
      });

      await runWithRequestContext(async () => {
        const mockRes1 = createMockResponse();
        await handler(mockReq, mockRes1);

        const mockRes2 = createMockResponse();
        await handler(mockReq, mockRes2);

        expect(executeMock).toHaveBeenCalledTimes(1);

        expect(mockRes1.write).toHaveBeenCalledWith("event: result\n");
        expect(mockRes2.write).toHaveBeenCalledWith("event: result\n");
      });
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

      const mockReq1 = createMockRequest({
        params: { query_key: "user_profile" },
        body: { parameters: { user_id: 1 } },
        headers: { "x-forwarded-access-token": "user-token-1" },
      });
      const mockRes1 = createMockResponse();
      await runWithRequestContext(
        async () => {
          await handler(mockReq1, mockRes1);
        },
        { userName: "user-token-1" },
      );

      const mockReq2 = createMockRequest({
        params: { query_key: "user_profile" },
        body: { parameters: { user_id: 2 } },
        headers: { "x-forwarded-access-token": "user-token-2" },
      });
      const mockRes2 = createMockResponse();
      await runWithRequestContext(
        async () => {
          await handler(mockReq2, mockRes2);
        },
        { userName: "user-token-2" },
      );

      const mockReq1Again = createMockRequest({
        params: { query_key: "user_profile" },
        body: { parameters: { user_id: 1 } },
        headers: { "x-forwarded-access-token": "user-token-1" },
      });
      const mockRes1Again = createMockResponse();
      await runWithRequestContext(
        async () => {
          await handler(mockReq1Again, mockRes1Again);
        },
        { userName: "user-token-1" },
      );

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

      const mockServiceClient = { service: "client" };
      await runWithRequestContext(
        async () => {
          await handler(mockReq, mockRes);
        },
        {
          serviceDatabricksClient: mockServiceClient as any,
        },
      );

      expect(executeMock).toHaveBeenCalledWith(
        mockServiceClient,
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
