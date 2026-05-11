import {
  createFailedSQLResponse,
  createSuccessfulSQLResponse,
} from "@tools/test-helpers";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SQLWarehouseConnector } from "../sql-warehouse";

// Pass-through telemetry stub: invokes the span callback with a no-op span.
vi.mock("../../telemetry", () => {
  const mockSpan = {
    end: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    addEvent: vi.fn(),
    isRecording: vi.fn().mockReturnValue(true),
    spanContext: vi.fn(),
  };

  return {
    TelemetryManager: {
      getProvider: vi.fn(() => ({
        startActiveSpan: vi
          .fn()
          .mockImplementation(async (_name, _options, fn) => {
            return await fn(mockSpan);
          }),
        getMeter: vi.fn().mockReturnValue({
          createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
          createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
        }),
      })),
    },
    SpanKind: { CLIENT: 2 },
    SpanStatusCode: { OK: 1, ERROR: 2 },
  };
});

/** Minimal `WorkspaceClient` stub with `executeStatement` / `getStatement` mocks. */
function makeClient() {
  const executeStatement = vi.fn();
  const getStatement = vi.fn();
  return {
    client: {
      statementExecution: { executeStatement, getStatement },
      config: { host: "https://test.databricks.com" },
    } as any,
    mocks: { executeStatement, getStatement },
  };
}

describe("SQLWarehouseConnector", () => {
  let connector: SQLWarehouseConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new SQLWarehouseConnector({ timeout: 5000 });
  });

  describe("submitStatement", () => {
    test("rejects when the statement is missing", async () => {
      const { client } = makeClient();
      await expect(
        connector.submitStatement(client, {
          statement: "",
          warehouse_id: "w-1",
        }),
      ).rejects.toThrow(/statement/);
    });

    test("rejects when the warehouse_id is missing", async () => {
      const { client } = makeClient();
      await expect(
        connector.submitStatement(client, {
          statement: "SELECT 1",
          warehouse_id: "",
        }),
      ).rejects.toThrow(/warehouse_id/);
    });

    test("rejects when the signal is already aborted", async () => {
      const { client } = makeClient();
      const ac = new AbortController();
      ac.abort();
      await expect(
        connector.submitStatement(
          client,
          { statement: "SELECT 1", warehouse_id: "w-1" },
          ac.signal,
        ),
      ).rejects.toThrow();
    });

    test("returns the raw response on success without polling", async () => {
      const { client, mocks } = makeClient();
      const response = createSuccessfulSQLResponse([["a"]], [{ name: "col" }]);
      mocks.executeStatement.mockResolvedValueOnce(response);

      const result = await connector.submitStatement(client, {
        statement: "SELECT 1",
        warehouse_id: "w-1",
      });

      expect(result).toBe(response);
      expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
      expect(mocks.getStatement).not.toHaveBeenCalled();
    });

    test("propagates a null response as a SQL Warehouse api failure", async () => {
      const { client, mocks } = makeClient();
      mocks.executeStatement.mockResolvedValueOnce(null);

      await expect(
        connector.submitStatement(client, {
          statement: "SELECT 1",
          warehouse_id: "w-1",
        }),
      ).rejects.toThrow(/SQL Warehouse/);
    });
  });

  describe("getStatement", () => {
    test("rejects when the signal is already aborted", async () => {
      const { client } = makeClient();
      const ac = new AbortController();
      ac.abort();
      await expect(
        connector.getStatement(client, "stmt-1", ac.signal),
      ).rejects.toThrow();
    });

    test("returns the raw response", async () => {
      const { client, mocks } = makeClient();
      const response = createSuccessfulSQLResponse([["x"]], [{ name: "col" }]);
      mocks.getStatement.mockResolvedValueOnce(response);

      const result = await connector.getStatement(client, "stmt-1");
      expect(result).toBe(response);
      expect(mocks.getStatement).toHaveBeenCalledWith(
        { statement_id: "stmt-1" },
        expect.anything(),
      );
    });

    test("rejects when the response is null", async () => {
      const { client, mocks } = makeClient();
      mocks.getStatement.mockResolvedValueOnce(null);

      await expect(connector.getStatement(client, "stmt-1")).rejects.toThrow(
        /SQL Warehouse/,
      );
    });
  });

  describe("pollStatement", () => {
    test("returns transformed result when status is SUCCEEDED on first poll", async () => {
      const { client, mocks } = makeClient();
      mocks.getStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse(
          [["alice", "30"]],
          [{ name: "name" }, { name: "age" }],
        ),
      );

      const result = await connector.pollStatement(client, "stmt-1");
      expect((result as any).result.data).toEqual([
        { name: "alice", age: "30" },
      ]);
    });

    test("throws statementFailed when status is FAILED", async () => {
      const { client, mocks } = makeClient();
      mocks.getStatement.mockResolvedValueOnce(
        createFailedSQLResponse("Table not found"),
      );

      await expect(connector.pollStatement(client, "stmt-1")).rejects.toThrow(
        /Table not found/,
      );
    });

    test("throws canceled when status is CANCELED", async () => {
      const { client, mocks } = makeClient();
      mocks.getStatement.mockResolvedValueOnce({
        status: { state: "CANCELED" },
        statement_id: "stmt-1",
      });

      await expect(connector.pollStatement(client, "stmt-1")).rejects.toThrow();
    });

    test("throws when the polling timeout is exceeded", async () => {
      // timeout: 0 trips the elapsed-time check on the second iteration.
      const tight = new SQLWarehouseConnector({ timeout: 0 });
      const { client, mocks } = makeClient();
      mocks.getStatement.mockResolvedValue({
        status: { state: "RUNNING" },
        statement_id: "stmt-1",
      });

      await expect(
        tight.pollStatement(client, "stmt-1", undefined, 0),
      ).rejects.toThrow(/Polling timeout exceeded/);
    });

    test("throws when the signal aborts during polling", async () => {
      const { client, mocks } = makeClient();
      mocks.getStatement.mockResolvedValueOnce({
        status: { state: "RUNNING" },
        statement_id: "stmt-1",
      });

      const ac = new AbortController();
      ac.abort();

      await expect(
        connector.pollStatement(client, "stmt-1", ac.signal),
      ).rejects.toThrow();
    });
  });

  describe("transformResult", () => {
    test("projects data_array into name-keyed rows", () => {
      const response = createSuccessfulSQLResponse(
        [
          ["alice", "30"],
          ["bob", "25"],
        ],
        [{ name: "name" }, { name: "age" }],
      );

      const result = connector.transformResult(response as any) as any;
      expect(result.result.data).toEqual([
        { name: "alice", age: "30" },
        { name: "bob", age: "25" },
      ]);
      expect(result.result.data_array).toBeUndefined();
    });

    test("parses STRING columns whose value looks like JSON", () => {
      const response = createSuccessfulSQLResponse(
        [['{"a":1}']],
        [{ name: "payload", type_name: "STRING" }],
      );

      const result = connector.transformResult(response as any) as any;
      expect(result.result.data[0].payload).toEqual({ a: 1 });
    });

    test("keeps the raw string when JSON parsing fails", () => {
      const response = createSuccessfulSQLResponse(
        [["{not-json"]],
        [{ name: "payload", type_name: "STRING" }],
      );

      const result = connector.transformResult(response as any) as any;
      expect(result.result.data[0].payload).toBe("{not-json");
    });

    test("returns the Arrow job handle for ARROW_STREAM responses", () => {
      const response = {
        status: { state: "SUCCEEDED" },
        statement_id: "stmt-arrow-1",
        manifest: { format: "ARROW_STREAM" },
        result: { external_links: [] },
      } as any;

      const result = connector.transformResult(response) as any;
      expect(result).toEqual({
        result: {
          statement_id: "stmt-arrow-1",
          status: { state: "SUCCEEDED", error: undefined },
        },
      });
    });

    test("passes the response through when there is no data_array", () => {
      const response = {
        status: { state: "SUCCEEDED" },
        statement_id: "stmt-1",
      } as any;

      const result = connector.transformResult(response);
      expect(result).toBe(response);
    });
  });

  describe("executeStatement", () => {
    test("transforms inline when submit returns SUCCEEDED", async () => {
      const { client, mocks } = makeClient();
      mocks.executeStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse([["a"]], [{ name: "col" }]),
      );

      const result = (await connector.executeStatement(client, {
        statement: "SELECT 'a' AS col",
        warehouse_id: "w-1",
      })) as any;

      expect(result.result.data).toEqual([{ col: "a" }]);
      expect(mocks.getStatement).not.toHaveBeenCalled();
    });

    test("polls when submit returns RUNNING and returns the polled result", async () => {
      const { client, mocks } = makeClient();
      mocks.executeStatement.mockResolvedValueOnce({
        status: { state: "RUNNING" },
        statement_id: "stmt-2",
      });
      mocks.getStatement.mockResolvedValueOnce(
        createSuccessfulSQLResponse([["b"]], [{ name: "col" }]),
      );

      const result = (await connector.executeStatement(client, {
        statement: "SELECT 'b' AS col",
        warehouse_id: "w-1",
      })) as any;

      expect(result.result.data).toEqual([{ col: "b" }]);
      expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
      expect(mocks.getStatement).toHaveBeenCalledTimes(1);
    });

    test("rejects when the signal is already aborted", async () => {
      const { client } = makeClient();
      const ac = new AbortController();
      ac.abort();
      await expect(
        connector.executeStatement(
          client,
          { statement: "SELECT 1", warehouse_id: "w-1" },
          ac.signal,
        ),
      ).rejects.toThrow();
    });
  });

  describe("error log redaction", () => {
    test("does not log the SQL statement on executeStatement error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const sensitiveStatement =
        "SELECT password, ssn FROM users WHERE email = 'admin@test.com'";

      const { client, mocks } = makeClient();
      mocks.executeStatement.mockRejectedValue(
        new Error("warehouse unavailable"),
      );

      await expect(
        connector.executeStatement(client, {
          statement: sensitiveStatement,
          warehouse_id: "test-warehouse",
        }),
      ).rejects.toThrow();

      const loggedOutput = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .join(" ");

      expect(loggedOutput).toContain("warehouse unavailable");
      expect(loggedOutput).not.toContain("password");
      expect(loggedOutput).not.toContain("ssn");
      expect(loggedOutput).not.toContain("admin@test.com");

      errorSpy.mockRestore();
    });

    test("does not log the SQL statement on polling error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { client, mocks } = makeClient();
      mocks.executeStatement.mockResolvedValue({
        statement_id: "stmt-123",
        status: { state: "RUNNING" },
      });
      mocks.getStatement.mockRejectedValue(new Error("polling timeout"));

      await expect(
        connector.executeStatement(client, {
          statement: "SELECT secret_data FROM vault",
          warehouse_id: "test-warehouse",
        }),
      ).rejects.toThrow();

      const loggedOutput = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .join(" ");

      // Polling errors bubble to executeStatement's catch — the single point that logs.
      expect(loggedOutput).toContain("polling timeout");
      expect(loggedOutput).not.toContain("secret_data");
      expect(loggedOutput).not.toContain("vault");

      errorSpy.mockRestore();
    });
  });
});
