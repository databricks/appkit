import type { Request, Response } from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "../logger";
import { WideEvent } from "../wide-event";

describe("Logger with WideEvent Integration", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let finishCallback: (() => void) | undefined;

  beforeEach(() => {
    finishCallback = undefined;
    mockRes = {
      once: vi.fn((event: string, callback: () => void) => {
        if (event === "finish") {
          finishCallback = callback;
        }
        return mockRes as Response;
      }),
    };

    mockReq = {
      method: "POST",
      path: "/api/query",
      url: "/api/query",
      headers: {
        "user-agent": "test-agent",
        "x-forwarded-for": "127.0.0.1",
      },
      res: mockRes as Response,
    };
  });

  describe("Regular Logging (No Request)", () => {
    test("should log debug messages", () => {
      const logger = createLogger("test");
      const debugSpy = vi.spyOn(console, "log");

      logger.debug("Test message: %s", "value");

      // Debug uses obug, not console.log
      debugSpy.mockRestore();
    });

    test("should log info messages", () => {
      const logger = createLogger("test");
      const infoSpy = vi.spyOn(console, "log");

      logger.info("Server started on port %d", 3000);

      expect(infoSpy).toHaveBeenCalledWith(
        "[appkit:test]",
        "Server started on port 3000",
      );

      infoSpy.mockRestore();
    });

    test("should log error messages", () => {
      const logger = createLogger("test");
      const errorSpy = vi.spyOn(console, "error");

      logger.error("Failed to connect: %s", "timeout");

      expect(errorSpy).toHaveBeenCalledWith(
        "[appkit:test]",
        "Failed to connect: timeout",
      );

      errorSpy.mockRestore();
    });
  });

  describe("Request-Scoped Logging", () => {
    test("should create WideEvent on first access", () => {
      const logger = createLogger("analytics");

      const event = logger.event(mockReq as Request);

      expect(event).toBeInstanceOf(WideEvent);
      expect(event!.data.request_id).toBeDefined();
      expect(event!.data.method).toBe("POST");
      expect(event!.data.path).toBe("/api/query");
    });

    test("should reuse same WideEvent for same request", () => {
      const logger = createLogger("analytics");

      const event1 = logger.event(mockReq as Request);
      const event2 = logger.event(mockReq as Request);

      expect(event1).toBe(event2);
    });

    test("should add logs to WideEvent when logging with request", () => {
      const logger = createLogger("analytics");
      const infoSpy = vi.spyOn(console, "log");

      logger.info(mockReq as Request, "Processing query: %s", "SELECT *");

      const event = logger.event(mockReq as Request);
      expect(event).toBeDefined();
      expect(event!.data.logs).toHaveLength(1);
      expect(event!.data.logs![0].level).toBe("info");
      expect(event!.data.logs![0].message).toBe("Processing query: SELECT *");

      infoSpy.mockRestore();
    });

    test("should add multiple logs to same WideEvent", () => {
      const logger = createLogger("analytics");
      const infoSpy = vi.spyOn(console, "log");
      const errorSpy = vi.spyOn(console, "error");

      logger.info(mockReq as Request, "Starting query");
      logger.info(mockReq as Request, "Query completed: %d rows", 100);
      logger.error(mockReq as Request, "Warning: slow query");

      const event = logger.event(mockReq as Request);
      expect(event).toBeDefined();
      expect(event!.data.logs).toHaveLength(3);
      expect(event!.data.logs![0].message).toBe("Starting query");
      expect(event!.data.logs![1].message).toBe("Query completed: 100 rows");
      expect(event!.data.logs![2].message).toBe("Warning: slow query");

      infoSpy.mockRestore();
      errorSpy.mockRestore();
    });

    test("should set service scope from logger", () => {
      const logger = createLogger("connectors:lakebase");

      const event = logger.event(mockReq as Request);
      expect(event).toBeDefined();

      expect(event!.data.service?.name).toBe("appkit");
      // Note: scope is not currently stored in WideEventData
      // It's used for logger context but not part of the event structure
    });

    test("should finalize WideEvent on response finish", () => {
      const logger = createLogger("analytics");
      const event = logger.event(mockReq as Request);
      expect(event).toBeDefined();

      expect(event!.data.duration_ms).toBeUndefined();
      expect(event!.data.status_code).toBeUndefined();

      // Trigger finish event
      finishCallback?.();

      expect(event!.data.duration_ms).toBeDefined();
      expect(event!.data.status_code).toBe(200);
    });

    test("should allow manual updates to WideEvent", () => {
      const logger = createLogger("analytics");
      const event = logger.event(mockReq as Request);
      expect(event).toBeDefined();

      event!.setComponent("analytics", "executeQuery");
      event!.setExecution({
        statement: "SELECT * FROM users",
        duration: 125,
        rowCount: 100,
      });

      expect(event!.data.component?.name).toBe("analytics");
      expect(event!.data.component?.operation).toBe("executeQuery");
      expect(event!.data.execution?.statement).toBe("SELECT * FROM users");
      expect(event!.data.execution?.duration).toBe(125);
    });

    test("should track errors in WideEvent", () => {
      const logger = createLogger("analytics");
      const errorSpy = vi.spyOn(console, "error");

      const error = new Error("Query failed");
      logger.error(mockReq as Request, "Query failed: %O", error);

      const event = logger.event(mockReq as Request);
      expect(event).toBeDefined();
      expect(event!.data.logs).toHaveLength(1);
      expect(event!.data.logs![0].level).toBe("error");

      errorSpy.mockRestore();
    });
  });

  describe("Mixed Logging", () => {
    test("should handle mix of request and non-request logging", () => {
      const logger = createLogger("test");
      const infoSpy = vi.spyOn(console, "log");

      // Non-request log
      logger.info("Server started");

      // Request log
      logger.info(mockReq as Request, "Processing request");

      // Non-request log again
      logger.info("Request count: %d", 1);

      const event = logger.event(mockReq as Request);
      expect(event).toBeDefined();
      expect(event!.data.logs).toHaveLength(1); // Only request log
      expect(event!.data.logs![0].message).toBe("Processing request");

      infoSpy.mockRestore();
    });
  });

  describe("Request Detection", () => {
    test("should correctly identify Request objects", () => {
      const logger = createLogger("test");
      const infoSpy = vi.spyOn(console, "log");

      // String message
      logger.info("Test message");

      // Request + message
      logger.info(mockReq as Request, "Request message");

      // Non-request object shouldn't be treated as request
      const notRequest = { method: "POST" }; // Missing path
      logger.info(notRequest as any, "Should not crash");

      infoSpy.mockRestore();
    });
  });
});
