import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WideEvent } from "../wide-event";

describe("WideEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    test("initializes with request_id", () => {
      const event = new WideEvent("req-123");
      const data = event.toJSON();

      expect(data.request_id).toBe("req-123");
    });

    test("initializes with timestamp", () => {
      const event = new WideEvent("req-123");
      const data = event.toJSON();

      expect(data.timestamp).toBe("2024-01-15T10:00:00.000Z");
    });

    test("initializes service metadata", () => {
      const event = new WideEvent("req-123");
      const data = event.toJSON();

      expect(data.service).toBeDefined();
      expect(data.service?.name).toBe("appkit");
    });

    test("initializes empty logs array", () => {
      const event = new WideEvent("req-123");
      const data = event.toJSON();

      expect(data.logs).toEqual([]);
    });

    test("initializes empty context object", () => {
      const event = new WideEvent("req-123");
      const data = event.toJSON();

      expect(data.context).toEqual({});
    });
  });

  describe("set", () => {
    test("sets simple values", () => {
      const event = new WideEvent("req-123");

      event.set("method", "POST");
      event.set("path", "/api/query");

      const data = event.toJSON();
      expect(data.method).toBe("POST");
      expect(data.path).toBe("/api/query");
    });

    test("merges object values", () => {
      const event = new WideEvent("req-123");

      // Use setContext for partial updates since service requires name and version
      event.setContext("test", { region: "us-west-2" });

      const data = event.toJSON();
      expect(data.context?.test?.region).toBe("us-west-2");
    });

    test("returns this for chaining", () => {
      const event = new WideEvent("req-123");

      const result = event.set("method", "GET");

      expect(result).toBe(event);
    });
  });

  describe("setComponent", () => {
    test("sets component name", () => {
      const event = new WideEvent("req-123");

      event.setComponent("analytics");

      const data = event.toJSON();
      expect(data.component?.name).toBe("analytics");
    });

    test("sets component name and operation", () => {
      const event = new WideEvent("req-123");

      event.setComponent("sql-warehouse", "executeQuery");

      const data = event.toJSON();
      expect(data.component?.name).toBe("sql-warehouse");
      expect(data.component?.operation).toBe("executeQuery");
    });

    test("returns this for chaining", () => {
      const event = new WideEvent("req-123");

      const result = event.setComponent("test");

      expect(result).toBe(event);
    });
  });

  describe("setUser", () => {
    test("sets user context", () => {
      const event = new WideEvent("req-123");

      event.setUser({ id: "user-456" });

      const data = event.toJSON();
      expect(data.user?.id).toBe("user-456");
    });

    test("merges with existing user context", () => {
      const event = new WideEvent("req-123");

      event.setUser({ id: "user-456" });
      event.setUser({ role: "admin" });

      const data = event.toJSON();
      expect(data.user?.id).toBe("user-456");
      expect(data.user?.role).toBe("admin");
    });
  });

  describe("setExecution", () => {
    test("sets execution context", () => {
      const event = new WideEvent("req-123");

      event.setExecution({ cache_hit: true, cache_key: "query:abc" });

      const data = event.toJSON();
      expect(data.execution?.cache_hit).toBe(true);
      expect(data.execution?.cache_key).toBe("query:abc");
    });

    test("merges with existing execution context", () => {
      const event = new WideEvent("req-123");

      event.setExecution({ cache_hit: true });
      event.setExecution({ retry_attempts: 2 });

      const data = event.toJSON();
      expect(data.execution?.cache_hit).toBe(true);
      expect(data.execution?.retry_attempts).toBe(2);
    });
  });

  describe("setStream", () => {
    test("sets stream context", () => {
      const event = new WideEvent("req-123");

      event.setStream({ stream_id: "stream-789", events_sent: 10 });

      const data = event.toJSON();
      expect(data.stream?.stream_id).toBe("stream-789");
      expect(data.stream?.events_sent).toBe(10);
    });

    test("merges with existing stream context", () => {
      const event = new WideEvent("req-123");

      event.setStream({ stream_id: "stream-789" });
      event.setStream({ buffer_size: 100 });

      const data = event.toJSON();
      expect(data.stream?.stream_id).toBe("stream-789");
      expect(data.stream?.buffer_size).toBe(100);
    });
  });

  describe("setError", () => {
    test("extracts standard error fields", () => {
      const event = new WideEvent("req-123");
      const error = new Error("Something went wrong");

      event.setError(error);

      const data = event.toJSON();
      expect(data.error?.type).toBe("Error");
      expect(data.error?.code).toBe("UNKNOWN_ERROR");
      expect(data.error?.message).toBe("Something went wrong");
      expect(data.error?.retriable).toBe(false);
    });

    test("extracts AppKitError fields", () => {
      const event = new WideEvent("req-123");
      const error = new Error("Validation failed") as any;
      error.name = "ValidationError";
      error.code = "INVALID_INPUT";
      error.statusCode = 400;
      error.isRetryable = false;

      event.setError(error);

      const data = event.toJSON();
      expect(data.error?.type).toBe("ValidationError");
      expect(data.error?.code).toBe("INVALID_INPUT");
      expect(data.error?.retriable).toBe(false);
    });

    test("extracts error cause", () => {
      const event = new WideEvent("req-123");
      const cause = new Error("Original error");
      const error = new Error("Wrapped error");
      (error as any).cause = cause;

      event.setError(error);

      const data = event.toJSON();
      expect(data.error?.cause).toBe("Error: Original error");
    });

    test("returns this for chaining", () => {
      const event = new WideEvent("req-123");

      const result = event.setError(new Error("test"));

      expect(result).toBe(event);
    });
  });

  describe("setContext", () => {
    test("adds scoped context", () => {
      const event = new WideEvent("req-123");

      event.setContext("analytics", { query_key: "apps_list" });

      const data = event.toJSON();
      expect(data.context?.analytics?.query_key).toBe("apps_list");
    });

    test("merges with existing scoped context", () => {
      const event = new WideEvent("req-123");

      event.setContext("analytics", { query_key: "apps_list" });
      event.setContext("analytics", { rows_returned: 100 });

      const data = event.toJSON();
      expect(data.context?.analytics?.query_key).toBe("apps_list");
      expect(data.context?.analytics?.rows_returned).toBe(100);
    });

    test("supports multiple scopes", () => {
      const event = new WideEvent("req-123");

      event.setContext("analytics", { query_key: "apps_list" });
      event.setContext("sql-warehouse", { warehouse_id: "wh-123" });

      const data = event.toJSON();
      expect(data.context?.analytics?.query_key).toBe("apps_list");
      expect(data.context?.["sql-warehouse"]?.warehouse_id).toBe("wh-123");
    });
  });

  describe("addLog", () => {
    test("adds log entry", () => {
      const event = new WideEvent("req-123");

      event.addLog("info", "Query started");

      const data = event.toJSON();
      expect(data.logs).toHaveLength(1);
      expect(data.logs?.[0].level).toBe("info");
      expect(data.logs?.[0].message).toBe("Query started");
      expect(data.logs?.[0].timestamp).toBe("2024-01-15T10:00:00.000Z");
    });

    test("adds log with context", () => {
      const event = new WideEvent("req-123");

      event.addLog("debug", "Cache lookup", { key: "user:123" });

      const data = event.toJSON();
      expect(data.logs?.[0].context).toEqual({ key: "user:123" });
    });

    test("supports all log levels", () => {
      const event = new WideEvent("req-123");

      event.addLog("debug", "debug message");
      event.addLog("info", "info message");
      event.addLog("warn", "warn message");
      event.addLog("error", "error message");

      const data = event.toJSON();
      expect(data.logs).toHaveLength(4);
      expect(data.logs?.map((l) => l.level)).toEqual([
        "debug",
        "info",
        "warn",
        "error",
      ]);
    });

    test("truncates logs at 50 entries", () => {
      const event = new WideEvent("req-123");

      for (let i = 0; i < 60; i++) {
        event.addLog("info", `message ${i}`);
      }

      const data = event.toJSON();
      expect(data.logs).toHaveLength(50);
      expect(data.logs?.[0].message).toBe("message 10");
      expect(data.logs?.[49].message).toBe("message 59");
    });

    test("returns this for chaining", () => {
      const event = new WideEvent("req-123");

      const result = event.addLog("info", "test");

      expect(result).toBe(event);
    });
  });

  describe("finalize", () => {
    test("sets status_code", () => {
      const event = new WideEvent("req-123");

      event.finalize(200);

      const data = event.toJSON();
      expect(data.status_code).toBe(200);
    });

    test("sets duration_ms", () => {
      const event = new WideEvent("req-123");

      vi.advanceTimersByTime(150);
      event.finalize(200);

      const data = event.toJSON();
      expect(data.duration_ms).toBe(150);
    });

    test("returns event data", () => {
      const event = new WideEvent("req-123");

      const result = event.finalize(201);

      expect(result.request_id).toBe("req-123");
      expect(result.status_code).toBe(201);
    });
  });

  describe("getDurationMs", () => {
    test("calculates duration from start time", () => {
      const event = new WideEvent("req-123");

      vi.advanceTimersByTime(250);

      expect(event.getDurationMs()).toBe(250);
    });

    test("returns set duration_ms if already set", () => {
      const event = new WideEvent("req-123");

      vi.advanceTimersByTime(50);
      event.finalize(200);

      vi.advanceTimersByTime(100);

      // Should return the duration at finalize time (50ms), not current time (150ms)
      expect(event.getDurationMs()).toBe(50);
    });
  });

  describe("toJSON", () => {
    test("returns complete event data", () => {
      const event = new WideEvent("req-123");

      event
        .set("method", "POST")
        .set("path", "/api/query")
        .setComponent("analytics", "query")
        .setUser({ id: "user-456" })
        .setExecution({ cache_hit: false })
        .addLog("info", "Started");

      const data = event.toJSON();

      expect(data.request_id).toBe("req-123");
      expect(data.method).toBe("POST");
      expect(data.path).toBe("/api/query");
      expect(data.component?.name).toBe("analytics");
      expect(data.user?.id).toBe("user-456");
      expect(data.execution?.cache_hit).toBe(false);
      expect(data.logs).toHaveLength(1);
    });
  });

  describe("chaining", () => {
    test("supports fluent API", () => {
      const event = new WideEvent("req-123");

      const data = event
        .set("method", "GET")
        .set("path", "/api/health")
        .setComponent("server", "healthCheck")
        .setUser({ id: "anonymous" })
        .setExecution({ timeout_ms: 5000 })
        .addLog("info", "Health check started")
        .finalize(200);

      expect(data.method).toBe("GET");
      expect(data.path).toBe("/api/health");
      expect(data.component?.name).toBe("server");
      expect(data.status_code).toBe(200);
    });
  });
});
