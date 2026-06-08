import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

  describe("ensureWarehouseRunning", () => {
    let connector: SQLWarehouseConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new SQLWarehouseConnector({ timeout: 5000 });
      // Use fake timers so the 3s poll interval doesn't sleep in real time.
      // Each test that needs polling drains scheduled timers via
      // `vi.runAllTimersAsync()` to fast-forward through the loop.
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("emits a single RUNNING update and returns when warehouse is already running", async () => {
      const get = vi.fn().mockResolvedValue({ state: "RUNNING" });
      const start = vi.fn();
      const wsClient = { warehouses: { get, start } };
      const updates: any[] = [];

      await connector.ensureWarehouseRunning(wsClient as any, "wh-1", {
        onStatus: (u) => updates.push(u),
      });

      expect(get).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
      expect(updates).toHaveLength(1);
      expect(updates[0].state).toBe("RUNNING");
      expect(updates[0].attempt).toBe(1);
    });

    test("starts a STOPPED warehouse and waits until RUNNING", async () => {
      const get = vi
        .fn()
        .mockResolvedValueOnce({ state: "STOPPED" })
        .mockResolvedValueOnce({ state: "STARTING" })
        .mockResolvedValueOnce({ state: "RUNNING" });
      const start = vi.fn().mockResolvedValue(undefined);
      const wsClient = { warehouses: { get, start } };
      const updates: any[] = [];

      const promise = connector.ensureWarehouseRunning(
        wsClient as any,
        "wh-2",
        {
          onStatus: (u) => updates.push(u),
          timeoutMs: 60_000,
        },
      );
      // Fast-forward through the inter-poll sleeps.
      await vi.runAllTimersAsync();
      await promise;

      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ id: "wh-2" }, expect.anything());
      // STOPPED branch emits a synthetic STARTING update before calling start,
      // then de-dup suppresses the redundant STARTING from the next poll,
      // and finally RUNNING is emitted.
      const states = updates.map((u) => u.state);
      expect(states).toEqual(["STARTING", "RUNNING"]);
      // attempt counter still increments per poll, so the final entry is on
      // the third observation even though only two updates fire.
      expect(updates.at(-1).attempt).toBe(3);
    });

    test("polls a STARTING warehouse until RUNNING without calling start", async () => {
      const get = vi
        .fn()
        .mockResolvedValueOnce({ state: "STARTING" })
        .mockResolvedValueOnce({ state: "RUNNING" });
      const start = vi.fn();
      const wsClient = { warehouses: { get, start } };
      const updates: any[] = [];

      const promise = connector.ensureWarehouseRunning(
        wsClient as any,
        "wh-3",
        {
          onStatus: (u) => updates.push(u),
          timeoutMs: 60_000,
        },
      );
      await vi.runAllTimersAsync();
      await promise;

      expect(start).not.toHaveBeenCalled();
      expect(updates.map((u) => u.state)).toEqual(["STARTING", "RUNNING"]);
    });

    test("rejects when warehouse is DELETED", async () => {
      const get = vi.fn().mockResolvedValue({ state: "DELETED" });
      const start = vi.fn();
      const wsClient = { warehouses: { get, start } };
      const updates: any[] = [];

      await expect(
        connector.ensureWarehouseRunning(wsClient as any, "wh-4", {
          onStatus: (u) => updates.push(u),
        }),
      ).rejects.toThrow(/configured SQL warehouse is DELETED/);

      expect(start).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    test("rejects when warehouse is DELETING", async () => {
      const get = vi.fn().mockResolvedValue({ state: "DELETING" });
      const start = vi.fn();
      const wsClient = { warehouses: { get, start } };
      const updates: any[] = [];

      await expect(
        connector.ensureWarehouseRunning(wsClient as any, "wh-deleting", {
          onStatus: (u) => updates.push(u),
        }),
      ).rejects.toThrow(/configured SQL warehouse is DELETING/);

      expect(start).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    test("aborts immediately when signal is already aborted", async () => {
      const get = vi.fn();
      const wsClient = { warehouses: { get, start: vi.fn() } };
      const controller = new AbortController();
      controller.abort();

      await expect(
        connector.ensureWarehouseRunning(wsClient as any, "wh-5", {
          onStatus: () => {},
          signal: controller.signal,
        }),
      ).rejects.toThrow(/canceled/i);
      expect(get).not.toHaveBeenCalled();
    });

    test("times out if warehouse never reaches RUNNING", async () => {
      const get = vi.fn().mockResolvedValue({ state: "STARTING" });
      const wsClient = { warehouses: { get, start: vi.fn() } };

      const promise = connector.ensureWarehouseRunning(
        wsClient as any,
        "wh-6",
        {
          onStatus: () => {},
          // 1ms timeout — the first poll succeeds (sleeps 3s), then the next
          // iteration sees elapsed > timeoutMs and throws.
          timeoutMs: 1,
        },
      );
      // Attach the assertion synchronously before running timers so the
      // rejection is awaited and not flagged as an unhandled promise.
      const assertion = expect(promise).rejects.toThrow(
        /did not reach RUNNING/,
      );
      await vi.runAllTimersAsync();
      await assertion;
    });

    test("rejects when warehouse_id is empty", async () => {
      const wsClient = {
        warehouses: { get: vi.fn(), start: vi.fn() },
      };

      await expect(
        connector.ensureWarehouseRunning(wsClient as any, "", {
          onStatus: () => {},
        }),
      ).rejects.toThrow(/warehouse_id/);
    });

    test("skips the SDK round-trip on a subsequent call within the recently-running TTL", async () => {
      const get = vi.fn().mockResolvedValue({ state: "RUNNING" });
      const wsClient = { warehouses: { get, start: vi.fn() } };

      const updates1: any[] = [];
      await connector.ensureWarehouseRunning(wsClient as any, "wh-cache", {
        onStatus: (u) => updates1.push(u),
      });

      const updates2: any[] = [];
      await connector.ensureWarehouseRunning(wsClient as any, "wh-cache", {
        onStatus: (u) => updates2.push(u),
      });

      // First call observed RUNNING and emitted; second call short-circuited.
      expect(get).toHaveBeenCalledTimes(1);
      expect(updates1.map((u) => u.state)).toEqual(["RUNNING"]);
      expect(updates2).toEqual([]);
    });

    test("rejects with ConfigurationError when STOPPED and autoStart is false", async () => {
      const get = vi.fn().mockResolvedValue({ state: "STOPPED" });
      const start = vi.fn();
      const wsClient = { warehouses: { get, start } };

      await expect(
        connector.ensureWarehouseRunning(wsClient as any, "wh-no-auto", {
          onStatus: () => {},
          autoStart: false,
        }),
      ).rejects.toThrow(/STOPPED.*auto-start is disabled/i);
      expect(start).not.toHaveBeenCalled();
    });

    test("de-duplicates successive equal states", async () => {
      const get = vi
        .fn()
        .mockResolvedValueOnce({ state: "STARTING" })
        .mockResolvedValueOnce({ state: "STARTING" })
        .mockResolvedValueOnce({ state: "STARTING" })
        .mockResolvedValueOnce({ state: "RUNNING" });
      const wsClient = { warehouses: { get, start: vi.fn() } };
      const updates: any[] = [];

      const promise = connector.ensureWarehouseRunning(
        wsClient as any,
        "wh-dedup",
        {
          onStatus: (u) => updates.push(u),
          timeoutMs: 60_000,
        },
      );
      await vi.runAllTimersAsync();
      await promise;

      // Three STARTING polls collapse into one emitted update; RUNNING is
      // its own emission. attempt counts every poll, not every emission.
      const states = updates.map((u) => u.state);
      expect(states).toEqual(["STARTING", "RUNNING"]);
    });

    test("does not leak raw SDK error text in the rethrown error", async () => {
      const sensitive =
        "getaddrinfo ENOTFOUND adb-1234567890.10.azuredatabricks.net";
      const get = vi.fn().mockRejectedValue(new Error(sensitive));
      const wsClient = { warehouses: { get, start: vi.fn() } };

      await expect(
        connector.ensureWarehouseRunning(wsClient as any, "wh-leak", {
          onStatus: () => {},
        }),
      ).rejects.toThrow(/Warehouse readiness check failed/);
      // Verify the raw SDK text didn't survive into the thrown error.
      try {
        await connector.ensureWarehouseRunning(wsClient as any, "wh-leak", {
          onStatus: () => {},
        });
      } catch (err) {
        expect((err as Error).message).not.toContain(sensitive);
        expect((err as Error).message).not.toContain("ENOTFOUND");
      }
    });

    test("continues the readiness loop when onStatus callback throws", async () => {
      // A consumer crash mid-poll must not abort the readiness contract;
      // the emitter swallows the throw onto the OTel span and the loop
      // keeps polling until the warehouse reports RUNNING.
      const get = vi
        .fn()
        .mockResolvedValueOnce({ state: "STARTING" })
        .mockResolvedValueOnce({ state: "RUNNING" });
      const wsClient = { warehouses: { get, start: vi.fn() } };
      let callCount = 0;

      const promise = connector.ensureWarehouseRunning(
        wsClient as any,
        "wh-throw",
        {
          onStatus: () => {
            callCount += 1;
            throw new Error("consumer crashed");
          },
          timeoutMs: 60_000,
        },
      );
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();

      expect(get).toHaveBeenCalledTimes(2);
      expect(callCount).toBe(2);
    });
  });
});
