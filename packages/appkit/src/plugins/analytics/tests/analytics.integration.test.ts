import type { Server } from "node:http";
import {
  createConfigurableMockWorkspaceClient,
  createFailedSQLResponse,
  createSuccessfulSQLResponse,
  mockServiceContext,
  parseSSEResponse,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { sql } from "shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { AppManager } from "../../../app";
import { ServiceContext } from "../../../context/service-context";
import { createApp } from "../../../core";
import { server as serverPlugin } from "../../server";
import { analytics } from "../index";

const getAppQuerySpy = vi.spyOn(AppManager.prototype, "getAppQuery");

describe("Analytics Plugin Integration", () => {
  let server: Server;
  let baseUrl: string;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  let mockClient: ReturnType<typeof createConfigurableMockWorkspaceClient>;
  const TEST_PORT = 9879;

  beforeAll(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();

    mockClient = createConfigurableMockWorkspaceClient();
    serviceContextMock = await mockServiceContext({
      serviceDatabricksClient: mockClient.client,
    });

    const app = await createApp({
      plugins: [
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
          autoStart: false,
        }),
        analytics({}),
      ],
    });

    await app.server.start();
    server = app.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  });

  afterAll(async () => {
    getAppQuerySpy?.mockRestore();
    serviceContextMock?.restore();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  beforeEach(() => {
    mockClient.mocks.executeStatement.mockReset();
    mockClient.mocks.getStatement.mockReset();
    getAppQuerySpy.mockReset();
  });

  describe("Query Execution", () => {
    test("should execute query and return transformed data", async () => {
      const testQuery = "SELECT name, age FROM users";
      const mockData = [
        ["Alice", "30"],
        ["Bob", "25"],
      ];
      const mockColumns = [
        { name: "name", type_name: "STRING" },
        { name: "age", type_name: "STRING" },
      ];

      getAppQuerySpy.mockResolvedValueOnce({
        query: testQuery,
        isAsUser: false,
      });

      mockClient.mocks.executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse(mockData, mockColumns),
      );

      const response = await fetch(
        `${baseUrl}/api/analytics/query/test_query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const sseData = await parseSSEResponse(response);
      expect(sseData.eventType).toBe("result");
      expect(sseData.data).toEqual([
        { name: "Alice", age: "30" },
        { name: "Bob", age: "25" },
      ]);

      expect(mockClient.mocks.executeStatement).toHaveBeenCalledTimes(1);
      expect(mockClient.mocks.executeStatement).toHaveBeenCalledWith(
        expect.objectContaining({
          statement: testQuery,
          warehouse_id: "test-warehouse-id",
        }),
        expect.anything(),
      );
    });

    test("should pass SQL parameters correctly", async () => {
      const testQuery = "SELECT * FROM users WHERE id = :user_id";

      getAppQuerySpy.mockResolvedValueOnce({
        query: testQuery,
        isAsUser: false,
      });

      mockClient.mocks.executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse([["Alice"]], [{ name: "name" }]),
      );

      const response = await fetch(
        `${baseUrl}/api/analytics/query/user_query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parameters: {
              user_id: sql.string("123"),
            },
          }),
        },
      );

      expect(response.status).toBe(200);

      const callArgs = mockClient.mocks.executeStatement.mock.calls[0][0];
      expect(callArgs.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "user_id",
            value: "123",
            type: "STRING",
          }),
        ]),
      );
    });
  });

  describe("Query Not Found", () => {
    test("should return 404 when query does not exist", async () => {
      getAppQuerySpy.mockResolvedValueOnce(null);

      const response = await fetch(
        `${baseUrl}/api/analytics/query/nonexistent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data).toEqual({ error: "Query not found" });

      expect(mockClient.mocks.executeStatement).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    test("should handle SQL execution failure", async () => {
      getAppQuerySpy.mockResolvedValueOnce({
        query: "SELECT * FROM broken",
        isAsUser: false,
      });

      mockClient.mocks.executeStatement.mockResolvedValue(
        createFailedSQLResponse("Table not found"),
      );

      const response = await fetch(`${baseUrl}/api/analytics/query/broken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parameters: {} }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("event: error");
    });

    test("should handle SDK exceptions", async () => {
      getAppQuerySpy.mockResolvedValueOnce({
        query: "SELECT 1",
        isAsUser: false,
      });

      mockClient.mocks.executeStatement.mockRejectedValue(
        new Error("Network error"),
      );

      const response = await fetch(`${baseUrl}/api/analytics/query/error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parameters: {} }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("event: error");
    });
  });

  describe("Caching", () => {
    test("should cache results for identical requests", async () => {
      const testQuery = "SELECT * FROM cached";

      getAppQuerySpy.mockResolvedValue({
        query: testQuery,
        isAsUser: false,
      });

      mockClient.mocks.executeStatement.mockResolvedValue(
        createSuccessfulSQLResponse([["cached_value"]], [{ name: "value" }]),
      );

      const response1 = await fetch(
        `${baseUrl}/api/analytics/query/cache_test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );
      const data1 = await parseSSEResponse(response1);

      const response2 = await fetch(
        `${baseUrl}/api/analytics/query/cache_test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );
      const data2 = await parseSSEResponse(response2);

      expect(data1.data).toEqual([{ value: "cached_value" }]);
      expect(data2.data).toEqual([{ value: "cached_value" }]);
      expect(mockClient.mocks.executeStatement).toHaveBeenCalledTimes(1);
    });
  });
});
