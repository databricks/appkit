import {
  createFailedSQLResponse,
  createSuccessfulSQLResponse,
  parseSSEResponse,
} from "@tools/test-helpers";
import { sql } from "shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { analytics } from "../../analytics";
import { createTestServer, type TestServerResult } from "./test-server";

describe("Analytics Plugin Integration", () => {
  let testServer: TestServerResult;

  beforeAll(async () => {
    testServer = await createTestServer({ plugins: [analytics({})] });
  });

  afterAll(async () => {
    await testServer.cleanup();
  });

  beforeEach(() => {
    testServer.mockWorkspaceClient.statementExecution.executeStatement.mockReset();
    testServer.mockWorkspaceClient.statementExecution.getStatement.mockReset();
    testServer.getAppQueryMock.mockReset();

    testServer.mockWorkspaceClient.statementExecution.executeStatement.mockResolvedValue(
      {
        status: { state: "SUCCEEDED" },
        statement_id: "stmt-default",
        result: { data_array: [] },
        manifest: { schema: { columns: [] } },
      },
    );
  });

  describe("Query Execution - Success", () => {
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

      testServer.getAppQueryMock.mockResolvedValueOnce({
        query: testQuery,
        isAsUser: false,
      });

      testServer.mockWorkspaceClient.statementExecution.executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse(mockData, mockColumns),
      );

      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/test_query`,
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
      expect(sseData.type).toBe("result");
      expect(sseData.data).toEqual([
        { name: "Alice", age: "30" },
        { name: "Bob", age: "25" },
      ]);

      expect(
        testServer.mockWorkspaceClient.statementExecution.executeStatement,
      ).toHaveBeenCalledTimes(1);

      expect(
        testServer.mockWorkspaceClient.statementExecution.executeStatement,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          statement: testQuery,
          warehouse_id: "test-warehouse-id",
          parameters: [],
        }),
        expect.anything(),
      );
    });

    test("should pass SQL parameters correctly to SDK", async () => {
      const testQuery =
        "SELECT * FROM users WHERE id = :user_id AND active = :active";
      const mockData = [["Alice", "123", "true"]];
      const mockColumns = [
        { name: "name", type_name: "STRING" },
        { name: "id", type_name: "STRING" },
        { name: "active", type_name: "STRING" },
      ];

      testServer.getAppQueryMock.mockResolvedValueOnce({
        query: testQuery,
        isAsUser: false,
      });

      testServer.mockWorkspaceClient.statementExecution.executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse(mockData, mockColumns),
      );

      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/user_query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parameters: {
              user_id: sql.string("123"),
              active: sql.boolean(true),
            },
          }),
        },
      );

      expect(response.status).toBe(200);

      expect(
        testServer.mockWorkspaceClient.statementExecution.executeStatement,
      ).toHaveBeenCalledTimes(1);

      const callArgs =
        testServer.mockWorkspaceClient.statementExecution.executeStatement.mock
          .calls[0][0];
      expect(callArgs.statement).toBe(testQuery);
      expect(callArgs.warehouse_id).toBe("test-warehouse-id");
      expect(callArgs.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "user_id",
            value: "123",
            type: "STRING",
          }),
          expect.objectContaining({
            name: "active",
            value: "true",
            type: "BOOLEAN",
          }),
        ]),
      );
      expect(callArgs.parameters).toHaveLength(2);
    });
  });

  describe("Query Execution - Not Found", () => {
    test("should return 404 when query file does not exist", async () => {
      testServer.getAppQueryMock.mockResolvedValueOnce(null);

      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/nonexistent_query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );

      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data).toEqual({ error: "Query not found" });

      expect(
        testServer.mockWorkspaceClient.statementExecution.executeStatement,
      ).toHaveBeenCalledTimes(0);
    });
  });

  describe("Query Execution - Error Handling", () => {
    test("should handle SDK execution failure", async () => {
      const testQuery = "SELECT * FROM broken_table";

      testServer.getAppQueryMock.mockResolvedValueOnce({
        query: testQuery,
        isAsUser: false,
      });

      // Use mockResolvedValue (not Once) to ensure retries also fail
      testServer.mockWorkspaceClient.statementExecution.executeStatement.mockResolvedValue(
        createFailedSQLResponse("Table not found: broken_table"),
      );

      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/broken_query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );

      // SSE always returns 200 initially, errors come as events
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const text = await response.text();
      expect(text).toContain("event: error");

      expect(
        testServer.mockWorkspaceClient.statementExecution.executeStatement,
      ).toHaveBeenCalled();
    });

    test("should handle SDK throwing an exception", async () => {
      const testQuery = "SELECT * FROM users";

      testServer.getAppQueryMock.mockResolvedValueOnce({
        query: testQuery,
        isAsUser: false,
      });

      // Use mockRejectedValue (not Once) to ensure retries also fail
      testServer.mockWorkspaceClient.statementExecution.executeStatement.mockRejectedValue(
        new Error("Network timeout"),
      );

      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/timeout_query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("event: error");

      expect(
        testServer.mockWorkspaceClient.statementExecution.executeStatement,
      ).toHaveBeenCalled();
    });
  });

  describe("Query Execution - Caching", () => {
    test("should cache results and not call SDK on second request", async () => {
      const testQuery = "SELECT * FROM cached_data";
      const mockData = [["cached_value"]];
      const mockColumns = [{ name: "value", type_name: "STRING" }];

      testServer.getAppQueryMock.mockResolvedValue({
        query: testQuery,
        isAsUser: false,
      });

      testServer.mockWorkspaceClient.statementExecution.executeStatement.mockResolvedValue(
        createSuccessfulSQLResponse(mockData, mockColumns),
      );

      const response1 = await fetch(
        `${testServer.baseUrl}/api/analytics/query/cached_query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );
      const data1 = await parseSSEResponse(response1);

      const response2 = await fetch(
        `${testServer.baseUrl}/api/analytics/query/cached_query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );
      const data2 = await parseSSEResponse(response2);

      expect(data1.data).toEqual([{ value: "cached_value" }]);
      expect(data2.data).toEqual([{ value: "cached_value" }]);

      // SDK called only once - second request uses cache
      expect(
        testServer.mockWorkspaceClient.statementExecution.executeStatement,
      ).toHaveBeenCalledTimes(1);
    });

    test("should use different cache keys for different parameters", async () => {
      const testQuery = "SELECT * FROM users WHERE id = :id";

      testServer.getAppQueryMock.mockResolvedValue({
        query: testQuery,
        isAsUser: false,
      });

      testServer.mockWorkspaceClient.statementExecution.executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse([["Alice"]], [{ name: "name" }]),
      );

      testServer.mockWorkspaceClient.statementExecution.executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse([["Bob"]], [{ name: "name" }]),
      );

      const response1 = await fetch(
        `${testServer.baseUrl}/api/analytics/query/user_by_id`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { id: sql.string("1") } }),
        },
      );
      const data1 = await parseSSEResponse(response1);

      const response2 = await fetch(
        `${testServer.baseUrl}/api/analytics/query/user_by_id`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: { id: sql.string("2") } }),
        },
      );
      const data2 = await parseSSEResponse(response2);

      expect(data1.data).toEqual([{ name: "Alice" }]);
      expect(data2.data).toEqual([{ name: "Bob" }]);

      expect(
        testServer.mockWorkspaceClient.statementExecution.executeStatement,
      ).toHaveBeenCalledTimes(2);
    });
  });

  describe("Query Execution - Data Type Transformation", () => {
    test("should correctly transform objects and array", async () => {
      const testQuery = "SELECT * FROM mixed_data";
      const mockData = [
        ["text", "123", "45.67", "true", '{"key":"value"}', '["a","b"]'],
      ];
      const mockColumns = [
        { name: "string_col", type_name: "STRING" },
        { name: "int_col", type_name: "STRING" },
        { name: "float_col", type_name: "STRING" },
        { name: "bool_col", type_name: "STRING" },
        { name: "json_obj", type_name: "STRING" },
        { name: "json_arr", type_name: "STRING" },
      ];

      testServer.getAppQueryMock.mockResolvedValueOnce({
        query: testQuery,
        isAsUser: false,
      });

      testServer.mockWorkspaceClient.statementExecution.executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse(mockData, mockColumns),
      );

      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/mixed_data`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );

      const sseData = await parseSSEResponse(response);

      expect(sseData.data).toHaveLength(1);
      expect(sseData.data[0]).toEqual({
        string_col: "text",
        int_col: "123",
        float_col: "45.67",
        bool_col: "true",
        json_obj: { key: "value" },
        json_arr: ["a", "b"],
      });

      expect(
        testServer.mockWorkspaceClient.statementExecution.executeStatement,
      ).toHaveBeenCalledTimes(1);
    });
  });
});
