import { beforeEach, describe, expect, test, vi } from "vitest";
import { SQLWarehouseConnector } from "../sql-warehouse";

// Mock telemetry to pass through span callbacks
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

describe("SQLWarehouseConnector", () => {
  describe("error log redaction", () => {
    let connector: SQLWarehouseConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new SQLWarehouseConnector({ timeout: 5000 });
    });

    test("should not log the SQL statement on executeStatement error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const sensitiveStatement =
        "SELECT password, ssn FROM users WHERE email = 'admin@test.com'";

      const mockWorkspaceClient = {
        statementExecution: {
          executeStatement: vi
            .fn()
            .mockRejectedValue(new Error("warehouse unavailable")),
        },
        config: { host: "https://test.databricks.com" },
      };

      await expect(
        connector.executeStatement(mockWorkspaceClient as any, {
          statement: sensitiveStatement,
          warehouse_id: "test-warehouse",
        }),
      ).rejects.toThrow();

      const loggedOutput = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .join(" ");

      // Should log the error message
      expect(loggedOutput).toContain("warehouse unavailable");

      // Should NOT log the SQL statement
      expect(loggedOutput).not.toContain("password");
      expect(loggedOutput).not.toContain("ssn");
      expect(loggedOutput).not.toContain("admin@test.com");

      errorSpy.mockRestore();
    });

    test("should not log the SQL statement on polling error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const mockWorkspaceClient = {
        statementExecution: {
          executeStatement: vi.fn().mockResolvedValue({
            statement_id: "stmt-123",
            status: { state: "RUNNING" },
          }),
          getStatement: vi.fn().mockRejectedValue(new Error("polling timeout")),
        },
        config: { host: "https://test.databricks.com" },
      };

      await expect(
        connector.executeStatement(mockWorkspaceClient as any, {
          statement: "SELECT secret_data FROM vault",
          warehouse_id: "test-warehouse",
        }),
      ).rejects.toThrow();

      const loggedOutput = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .join(" ");

      // Errors raised inside polling bubble up to executeStatement's catch,
      // which is the single point that logs (gated on isAborted). The poll
      // layer no longer logs to avoid double-logging the same failure.
      expect(loggedOutput).toContain("polling timeout");

      // Should NOT log the SQL statement
      expect(loggedOutput).not.toContain("secret_data");
      expect(loggedOutput).not.toContain("vault");

      errorSpy.mockRestore();
    });
  });
});
