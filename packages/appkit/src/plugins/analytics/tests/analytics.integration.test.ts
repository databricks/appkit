import {
  createFailedSQLResponse,
  createSuccessfulSQLResponse,
  createTestApp,
  getMockFn,
  parseSSEResponse,
  type TestApp,
} from "@databricks/appkit/testing";
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
import { analytics } from "../index";

const getAppQuerySpy = vi.spyOn(AppManager.prototype, "getAppQuery");

describe("Analytics Plugin Integration", () => {
  let app: TestApp<[ReturnType<typeof analytics>]>;
  /** The SQL mock the analytics route drives, via the harness's client. */
  let executeStatement: ReturnType<typeof getMockFn>;
  let getStatement: ReturnType<typeof getMockFn>;

  beforeAll(async () => {
    // The harness owns the env setup, the singleton resets, the mock client, the
    // server plugin on an ephemeral port, and the teardown. What used to be ~45
    // lines of setup plus a local getListeningPort helper is this call.
    app = await createTestApp({ plugins: [analytics({})] });
    executeStatement = getMockFn(
      app.client,
      "statementExecution.executeStatement",
    );
    getStatement = getMockFn(app.client, "statementExecution.getStatement");
  });

  afterAll(async () => {
    getAppQuerySpy?.mockRestore();
    await app?.close();
  });

  beforeEach(() => {
    // Reset drops the built-in canned SUCCEEDED default too, matching the
    // "script it yourself" semantics this suite relied on before.
    executeStatement.mockReset();
    getStatement.mockReset();
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

      executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse(mockData, mockColumns),
      );

      const response = await app.post("/api/analytics/query/test_query", {
        body: { parameters: {} },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "text/event-stream; charset=utf-8",
      );

      const sseData = await parseSSEResponse(response);
      expect(sseData.eventType).toBe("result");
      expect(sseData.data).toEqual([
        { name: "Alice", age: "30" },
        { name: "Bob", age: "25" },
      ]);

      expect(executeStatement).toHaveBeenCalledTimes(1);
      expect(executeStatement).toHaveBeenCalledWith(
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

      executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse([["Alice"]], [{ name: "name" }]),
      );

      const response = await app.post("/api/analytics/query/user_query", {
        body: { parameters: { user_id: sql.string("123") } },
      });

      expect(response.status).toBe(200);

      const callArgs = executeStatement.mock.calls[0][0];
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

      const response = await app.post("/api/analytics/query/nonexistent", {
        body: { parameters: {} },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data).toEqual({ error: "Query not found" });

      expect(executeStatement).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    test("should handle SQL execution failure", async () => {
      getAppQuerySpy.mockResolvedValueOnce({
        query: "SELECT * FROM broken",
        isAsUser: false,
      });

      executeStatement.mockResolvedValue(
        createFailedSQLResponse("Table not found"),
      );

      const response = await app.post("/api/analytics/query/broken", {
        body: { parameters: {} },
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

      executeStatement.mockRejectedValue(new Error("Network error"));

      const response = await app.post("/api/analytics/query/error", {
        body: { parameters: {} },
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

      executeStatement.mockResolvedValue(
        createSuccessfulSQLResponse([["cached_value"]], [{ name: "value" }]),
      );

      const response1 = await app.post("/api/analytics/query/cache_test", {
        body: { parameters: {} },
      });
      const data1 = await parseSSEResponse(response1);

      const response2 = await app.post("/api/analytics/query/cache_test", {
        body: { parameters: {} },
      });
      const data2 = await parseSSEResponse(response2);

      expect(data1.data).toEqual([{ value: "cached_value" }]);
      expect(data2.data).toEqual([{ value: "cached_value" }]);
      expect(executeStatement).toHaveBeenCalledTimes(1);
    });
  });
});
