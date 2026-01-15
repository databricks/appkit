import { logs } from "@opentelemetry/api-logs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WideEventData } from "../wide-event";
import { WideEventEmitter } from "../wide-event-emitter";

// Mock OpenTelemetry logs API
vi.mock("@opentelemetry/api-logs", () => ({
  logs: {
    getLogger: vi.fn(() => ({
      emit: vi.fn(),
    })),
  },
  SeverityNumber: {
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
  },
}));

describe("WideEventEmitter", () => {
  let emitter: WideEventEmitter;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      emit: vi.fn(),
    };
    vi.mocked(logs.getLogger).mockReturnValue(mockLogger);
    emitter = new WideEventEmitter();
  });

  const baseEvent: WideEventData = {
    timestamp: "2026-01-13T10:00:00.000Z",
    request_id: "req_123",
    method: "GET",
    path: "/api/test",
    status_code: 200,
    duration_ms: 125,
    service: {
      name: "appkit",
      version: "1.0.0",
      node_env: "production",
    },
  };

  test("should emit basic event to OpenTelemetry", () => {
    emitter.emit(baseEvent);

    expect(mockLogger.emit).toHaveBeenCalledTimes(1);
    const logRecord = mockLogger.emit.mock.calls[0][0];

    expect(logRecord.timestamp).toBeDefined();
    expect(logRecord.severityNumber).toBeDefined();
    expect(logRecord.body).toContain("GET /api/test");
    expect(logRecord.body).toContain("200");
    expect(logRecord.attributes).toBeDefined();
  });

  test("should set correct severity for successful requests", () => {
    emitter.emit(baseEvent);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.severityText).toBe("INFO");
  });

  test("should set ERROR severity for events with errors", () => {
    const event: WideEventData = {
      ...baseEvent,
      error: {
        type: "Error",
        code: "QUERY_FAILED",
        message: "Query failed",
        retriable: false,
      },
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.severityText).toBe("ERROR");
  });

  test("should set ERROR severity for 5xx status codes", () => {
    const event: WideEventData = {
      ...baseEvent,
      status_code: 500,
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.severityText).toBe("ERROR");
  });

  test("should set WARN severity for 4xx status codes", () => {
    const event: WideEventData = {
      ...baseEvent,
      status_code: 404,
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.severityText).toBe("WARN");
  });

  test("should include HTTP attributes", () => {
    emitter.emit(baseEvent);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.attributes["http.method"]).toBe("GET");
    expect(logRecord.attributes["http.route"]).toBe("/api/test");
    expect(logRecord.attributes["http.status_code"]).toBe(200);
    expect(logRecord.attributes["http.request.duration_ms"]).toBe(125);
  });

  test("should include trace ID if present", () => {
    const event: WideEventData = {
      ...baseEvent,
      trace_id: "abc123def456",
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.attributes["trace_id"]).toBe("abc123def456");
  });

  test("should include component information", () => {
    const event: WideEventData = {
      ...baseEvent,
      component: {
        name: "analytics",
        operation: "executeQuery",
      },
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.body).toContain("[analytics.executeQuery]");
    expect(logRecord.attributes["component.name"]).toBe("analytics");
    expect(logRecord.attributes["component.operation"]).toBe("executeQuery");
  });

  test("should include error details in attributes", () => {
    const event: WideEventData = {
      ...baseEvent,
      error: {
        type: "ValidationError",
        code: "INVALID_PARAM",
        message: "Invalid parameter",
        retriable: false,
      },
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.body).toContain("ERROR: Invalid parameter");
    expect(logRecord.attributes["error.type"]).toBe("ValidationError");
    expect(logRecord.attributes["error.code"]).toBe("INVALID_PARAM");
    expect(logRecord.attributes["error.message"]).toBe("Invalid parameter");
    expect(logRecord.attributes["error.retriable"]).toBe(false);
  });

  test("should include execution metadata", () => {
    const event: WideEventData = {
      ...baseEvent,
      execution: {
        cache_hit: true,
        cache_key: "test-key",
        retry_attempts: 2,
      },
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.attributes["execution.cache_hit"]).toBe(true);
    expect(logRecord.attributes["execution.cache_key"]).toBe("test-key");
    expect(logRecord.attributes["execution.retry_attempts"]).toBe(2);
  });

  test("should include custom context as attributes", () => {
    const event: WideEventData = {
      ...baseEvent,
      context: {
        analytics: {
          query_key: "user_stats",
          cache_hit: true,
        },
        warehouse: {
          warehouse_id: "abc123",
        },
      },
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.attributes["analytics.query_key"]).toBe("user_stats");
    expect(logRecord.attributes["analytics.cache_hit"]).toBe(true);
    expect(logRecord.attributes["warehouse.warehouse_id"]).toBe("abc123");
  });

  test("should include log count", () => {
    const event: WideEventData = {
      ...baseEvent,
      logs: [
        { level: "info", message: "Log 1", timestamp: "2026-01-13T10:00:00Z" },
        { level: "info", message: "Log 2", timestamp: "2026-01-13T10:00:01Z" },
      ],
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.attributes["log_count"]).toBe(2);
  });

  test("should not include undefined attributes", () => {
    const event: WideEventData = {
      ...baseEvent,
      // No error, user, or component
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.attributes["error.type"]).toBeUndefined();
    expect(logRecord.attributes["user.id"]).toBeUndefined();
    expect(logRecord.attributes["component.name"]).toBeUndefined();
  });

  test("should format log body correctly", () => {
    const event: WideEventData = {
      ...baseEvent,
      method: "POST",
      path: "/api/query",
      status_code: 201,
      duration_ms: 250,
      component: {
        name: "analytics",
        operation: "executeQuery",
      },
    };

    emitter.emit(event);

    const logRecord = mockLogger.emit.mock.calls[0][0];
    expect(logRecord.body).toBe(
      "POST /api/query → 201 (250ms) [analytics.executeQuery]",
    );
  });
});
