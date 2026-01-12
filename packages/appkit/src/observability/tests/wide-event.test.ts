import { describe, expect, test } from "vitest";
import { WideEvent } from "../wide-event";

describe("WideEvent", () => {
  test("should initialize with request ID", () => {
    const event = new WideEvent("test-request-123");
    const data = event.toJSON();

    expect(data.request_id).toBe("test-request-123");
    expect(data.timestamp).toBeDefined();
    expect(data.service).toBeDefined();
    expect(data.logs).toEqual([]);
    expect(data.context).toEqual({});
  });

  describe("set()", () => {
    test("should set primitive values", () => {
      const event = new WideEvent("req-1");
      event.set("method", "POST");
      event.set("path", "/api/test");
      event.set("status_code", 200);

      const data = event.toJSON();
      expect(data.method).toBe("POST");
      expect(data.path).toBe("/api/test");
      expect(data.status_code).toBe(200);
    });

    test("should merge object values", () => {
      const event = new WideEvent("req-1");
      event.set("user", { id: "123" });
      event.set("user", { email: "test@example.com" });

      const data = event.toJSON();
      expect(data.user).toEqual({ id: "123", email: "test@example.com" });
    });
  });

  describe("setComponent()", () => {
    test("should set component name and operation", () => {
      const event = new WideEvent("req-1");
      event.setComponent("analytics", "query");

      const data = event.toJSON();
      expect(data.component).toEqual({ name: "analytics", operation: "query" });
    });

    test("should set component name without operation", () => {
      const event = new WideEvent("req-1");
      event.setComponent("sql-warehouse");

      const data = event.toJSON();
      expect(data.component).toEqual({
        name: "sql-warehouse",
        operation: undefined,
      });
    });
  });

  describe("setUser()", () => {
    test("should merge user context", () => {
      const event = new WideEvent("req-1");
      event.setUser({ id: "user-123" });
      event.setUser({ email: "user@test.com" });

      const data = event.toJSON();
      expect(data.user).toEqual({ id: "user-123", email: "user@test.com" });
    });
  });

  describe("setExecution()", () => {
    test("should merge execution context", () => {
      const event = new WideEvent("req-1");
      event.setExecution({ cache_hit: true });
      event.setExecution({ retry_attempts: 3 });

      const data = event.toJSON();
      expect(data.execution).toEqual({ cache_hit: true, retry_attempts: 3 });
    });
  });

  describe("setStream()", () => {
    test("should merge stream context", () => {
      const event = new WideEvent("req-1");
      event.setStream({ stream_id: "stream-123" });
      event.setStream({ events_sent: 42 });

      const data = event.toJSON();
      expect(data.stream).toEqual({ stream_id: "stream-123", events_sent: 42 });
    });
  });

  describe("setError()", () => {
    test("should set error from Error object", () => {
      const event = new WideEvent("req-1");
      const error = new Error("Test error");
      error.name = "TestError";

      event.setError(error);

      const data = event.toJSON();
      expect(data.error).toEqual({
        type: "TestError",
        code: "UNKNOWN_ERROR",
        message: "Test error",
        retriable: false,
        cause: undefined,
      });
    });

    test("should detect AppKit errors with code", () => {
      const event = new WideEvent("req-1");
      const error: any = new Error("AppKit error");
      error.code = "WAREHOUSE_NOT_FOUND";
      error.statusCode = 404;
      error.retriable = true;

      event.setError(error);

      const data = event.toJSON();
      expect(data.error?.code).toBe("WAREHOUSE_NOT_FOUND");
      expect(data.error?.retriable).toBe(true);
    });
  });

  describe("setContext()", () => {
    test("should add scoped context", () => {
      const event = new WideEvent("req-1");
      event.setContext("analytics", { query_key: "apps_list" });
      event.setContext("sql-warehouse", { warehouse_id: "wh-123" });

      const data = event.toJSON();
      expect(data.context).toEqual({
        analytics: { query_key: "apps_list" },
        "sql-warehouse": { warehouse_id: "wh-123" },
      });
    });

    test("should merge context for same scope", () => {
      const event = new WideEvent("req-1");
      event.setContext("plugin", { step: 1 });
      event.setContext("plugin", { step: 2, status: "ok" });

      const data = event.toJSON();
      expect(data.context?.plugin).toEqual({ step: 2, status: "ok" });
    });
  });

  describe("addLog()", () => {
    test("should add log entry", () => {
      const event = new WideEvent("req-1");
      event.addLog("info", "Test message", { key: "value" });

      const data = event.toJSON();
      expect(data.logs).toHaveLength(1);
      expect(data.logs?.[0]).toMatchObject({
        level: "info",
        message: "Test message",
        context: { key: "value" },
      });
      expect(data.logs?.[0].timestamp).toBeDefined();
    });

    test("should truncate logs after 50 entries", () => {
      const event = new WideEvent("req-1");

      // Add 60 logs
      for (let i = 0; i < 60; i++) {
        event.addLog("info", `Message ${i}`);
      }

      const data = event.toJSON();
      expect(data.logs).toHaveLength(50);
      // Should keep the last 50
      expect(data.logs?.[0].message).toBe("Message 10");
      expect(data.logs?.[49].message).toBe("Message 59");
    });
  });

  describe("finalize()", () => {
    test("should set status code and duration", async () => {
      const event = new WideEvent("req-1");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const data = event.finalize(200);

      expect(data.status_code).toBe(200);
      expect(data.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getDurationMs()", () => {
    test("should calculate duration from start time", async () => {
      const event = new WideEvent("req-1");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const duration = event.getDurationMs();
      expect(duration).toBeGreaterThanOrEqual(10);
    });
  });

  describe("toJSON()", () => {
    test("should return complete WideEventData", () => {
      const event = new WideEvent("req-1");
      event.set("method", "POST");
      event.set("path", "/api/test");
      event.setComponent("analytics", "query");
      event.addLog("info", "Test log");

      const data = event.toJSON();
      expect(data.request_id).toBe("req-1");
      expect(data.method).toBe("POST");
      expect(data.path).toBe("/api/test");
      expect(data.component).toEqual({ name: "analytics", operation: "query" });
      expect(data.logs).toHaveLength(1);
    });
  });
});
