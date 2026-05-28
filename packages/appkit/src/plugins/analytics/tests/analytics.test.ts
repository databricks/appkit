import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  createStubTaskManager,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { sql } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { TaskManager } from "../../../tasks";
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
      async (
        key: unknown[],
        fn: (signal?: AbortSignal) => Promise<unknown>,
        userKey: string,
      ) => {
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
  let taskStub: ReturnType<typeof createStubTaskManager>;
  let getInstanceSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    config = { timeout: 5000 };
    setupDatabricksEnv();
    mockCacheStore.clear();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    // The Plugin base eager-binds `this.task` from the singleton.
    // Stub runs the registered handler in-process — no WAL or FFI.
    taskStub = createStubTaskManager();
    getInstanceSyncSpy = vi
      .spyOn(TaskManager, "getInstanceSync")
      .mockReturnValue(taskStub as unknown as TaskManager);
  });

  afterEach(() => {
    serviceContextMock?.restore();
    getInstanceSyncSpy?.mockRestore();
  });

  /** Instantiates and registers the `analytics:query` task on the stub. */
  async function makeReadyPlugin(cfg: IAnalyticsConfig = config) {
    const plugin = new AnalyticsPlugin(cfg);
    await plugin.setup();
    return plugin;
  }

  /** Builds the SUCCEEDED `submitStatement` response from `[rows, columns]`. */
  function makeSucceededSubmission(
    data: unknown[][],
    columns: Array<{ name: string; type_name?: string }>,
  ) {
    return {
      status: { state: "SUCCEEDED" as const },
      statement_id: `stmt-${Math.random().toString(36).slice(2, 10)}`,
      result: { data_array: data },
      manifest: {
        schema: {
          columns: columns.map((c) => ({
            name: c.name,
            type_name: c.type_name ?? "STRING",
          })),
        },
      },
    };
  }

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

    test("/query/:query_key should execute as service principal for .sql files (isAsUser: false)", async () => {
      const plugin = await makeReadyPlugin();
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      let capturedWorkspaceClient: any;
      const submitMock = vi
        .fn()
        .mockImplementation((workspaceClient, ..._args) => {
          capturedWorkspaceClient = workspaceClient;
          return Promise.resolve(
            makeSucceededSubmission(
              [[1, "test"]],
              [{ name: "id" }, { name: "name" }],
            ),
          );
        });
      (plugin as any).SQLClient.submitStatement = submitMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {} },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(capturedWorkspaceClient).toBeDefined();

      expect(submitMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: "SELECT * FROM test",
          warehouse_id: "test-warehouse-id",
        }),
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

      // Bridge emits `event: data` with `{ type, ...flat }` (see `_emitDataFrame`).
      expect(mockRes.write).toHaveBeenCalledWith("event: data\n");
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"data":[{"id":1,"name":"test"}]'),
      );

      expect(mockRes.end).toHaveBeenCalled();
    });

    test("/query/:query_key should execute as user for .obo.sql files (isAsUser: true)", async () => {
      const plugin = await makeReadyPlugin();
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM users WHERE id = :user_id",
        isAsUser: true,
      });

      let capturedWorkspaceClient: any;
      const submitMock = vi
        .fn()
        .mockImplementation((workspaceClient, ..._args: any[]) => {
          capturedWorkspaceClient = workspaceClient;
          return Promise.resolve(
            makeSucceededSubmission(
              [[123, "Alice"]],
              [{ name: "user_id", type_name: "BIGINT" }, { name: "name" }],
            ),
          );
        });
      (plugin as any).SQLClient.submitStatement = submitMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
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

      expect(capturedWorkspaceClient).toBeDefined();

      expect(submitMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: "SELECT * FROM users WHERE id = :user_id",
          warehouse_id: "test-warehouse-id",
        }),
      );

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream; charset=utf-8",
      );

      expect(mockRes.write).toHaveBeenCalledWith("event: data\n");
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"user_id":123'),
      );

      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should use different idempotency keys for .sql vs .obo.sql queries", async () => {
      const plugin = await makeReadyPlugin();
      const { router, getHandler } = createMockRouter();

      const getAppQueryMock = vi.fn();
      (plugin as any).app.getAppQuery = getAppQueryMock;

      const submitMock = vi
        .fn()
        .mockResolvedValue(makeSucceededSubmission([[1]], [{ name: "id" }]));
      (plugin as any).SQLClient.submitStatement = submitMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/query/:query_key");

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

      // SP and OBO contribute distinct `executorKey` + `isAsUser` → distinct IK → both submit.
      expect(submitMock).toHaveBeenCalledTimes(2);
    });

    test("identical .sql requests return identical data on every call", async () => {
      const plugin = await makeReadyPlugin();
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test WHERE foo = :foo",
        isAsUser: false,
      });

      const submitMock = vi
        .fn()
        .mockResolvedValue(
          makeSucceededSubmission(
            [[1, "cached"]],
            [{ name: "id" }, { name: "name" }],
          ),
        );
      (plugin as any).SQLClient.submitStatement = submitMock;

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

      // We don't assert `submitMock.callCount` — `at_least_once` dedupes
      // in-flight only, so terminal-state re-execution is legitimate.
      expect(mockRes1.write).toHaveBeenCalledWith("event: data\n");
      expect(mockRes2.write).toHaveBeenCalledWith("event: data\n");
      expect(mockRes1.write).toHaveBeenCalledWith(
        expect.stringContaining('"data":[{"id":1,"name":"cached"}]'),
      );
      expect(mockRes2.write).toHaveBeenCalledWith(
        expect.stringContaining('"data":[{"id":1,"name":"cached"}]'),
      );
    });

    test(".sql requests use a shared idempotency key across users", async () => {
      const plugin = await makeReadyPlugin();
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM shared_data",
        isAsUser: false,
      });

      const submitMock = vi
        .fn()
        .mockResolvedValue(
          makeSucceededSubmission(
            [[1, "shared"]],
            [{ name: "id" }, { name: "name" }],
          ),
        );
      (plugin as any).SQLClient.submitStatement = submitMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");

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

      // SP queries share `executorKey: "global"` across users → shared IK.
      const startCalls = (taskStub.start as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(startCalls).toHaveLength(3);
      const iks = startCalls.map(
        (c) => (c[1] as { executorKey: string }).executorKey,
      );
      expect(iks).toEqual(["global", "global", "global"]);

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

    test(".obo.sql queries get per-user idempotency keys", async () => {
      const plugin = await makeReadyPlugin();
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM users WHERE id = :user_id",
        isAsUser: true,
      });

      const submitMock = vi
        .fn()
        .mockResolvedValueOnce(
          makeSucceededSubmission(
            [[1, "Alice"]],
            [{ name: "user_id", type_name: "BIGINT" }, { name: "name" }],
          ),
        )
        .mockResolvedValueOnce(
          makeSucceededSubmission(
            [[2, "Bob"]],
            [{ name: "user_id", type_name: "BIGINT" }, { name: "name" }],
          ),
        );
      (plugin as any).SQLClient.submitStatement = submitMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");

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

      // Distinct OBO callers → distinct executorKeys → both submit.
      expect(submitMock).toHaveBeenCalledTimes(2);

      const startCalls = (taskStub.start as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(startCalls).toHaveLength(2);
      const executorKeys = startCalls.map(
        (c) => (c[1] as { executorKey: string }).executorKey,
      );
      expect(new Set(executorKeys).size).toBe(2);

      expect(mockRes1.write).toHaveBeenCalledWith(
        expect.stringContaining('"name":"Alice"'),
      );
      expect(mockRes2.write).toHaveBeenCalledWith(
        expect.stringContaining('"name":"Bob"'),
      );
    });

    test("OBO IK must include the end user's ID, not the service principal's", async () => {
      const plugin = await makeReadyPlugin();
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM my_data",
        isAsUser: true,
      });

      const submitMock = vi
        .fn()
        .mockResolvedValueOnce(
          makeSucceededSubmission([["alice-data"]], [{ name: "owner" }]),
        )
        .mockResolvedValueOnce(
          makeSucceededSubmission([["bob-data"]], [{ name: "owner" }]),
        );
      (plugin as any).SQLClient.submitStatement = submitMock;

      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/query/:query_key");

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

      // `executorKey` resolves to the OBO end user's id, not the SP — distinct IKs.
      expect(submitMock).toHaveBeenCalledTimes(2);

      const startCalls = (taskStub.start as ReturnType<typeof vi.fn>).mock
        .calls;
      const executorKeys = startCalls.map(
        (c) => (c[1] as { executorKey: string }).executorKey,
      );
      expect(executorKeys).toContain("alice");
      expect(executorKeys).toContain("bob");

      expect(aliceRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"owner":"alice-data"'),
      );
      expect(bobRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"owner":"bob-data"'),
      );
    });

    test("submitStatement is called with the correct request body", async () => {
      const plugin = await makeReadyPlugin();
      const { router, getHandler } = createMockRouter();

      (plugin as any).app.getAppQuery = vi.fn().mockResolvedValue({
        query: "SELECT * FROM test",
        isAsUser: false,
      });

      const submitMock = vi
        .fn()
        .mockResolvedValue(makeSucceededSubmission([[1]], [{ name: "id" }]));
      (plugin as any).SQLClient.submitStatement = submitMock;

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/query/:query_key");
      const mockReq = createMockRequest({
        params: { query_key: "test_query" },
        body: { parameters: {} },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // Durable path routes through `submitStatement` (so statement_id
      // can be checkpointed) and skips the AbortSignal — cancellation
      // is cooperative via `this.task.stop`.
      expect(submitMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statement: "SELECT * FROM test",
          parameters: [],
          warehouse_id: "test-warehouse-id",
        }),
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
