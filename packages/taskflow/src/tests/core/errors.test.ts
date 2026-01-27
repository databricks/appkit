import { describe, expect, it } from "vitest";
import {
  BackpressureError,
  ConfigValidationError,
  ConflictError,
  ErrorCodes,
  InitializationError,
  isRetryableError,
  isTaskSystemError,
  NotFoundError,
  RetryExhaustedError,
  SlotTimeoutError,
  StreamOverflowError,
  TaskStateError,
  TaskSystemError,
  ValidationError,
} from "@/core/errors";

describe("Core Errors", () => {
  describe("TaskSystemError", () => {
    it("should create with message, context and timestamp", () => {
      const error = new TaskSystemError(
        "Test error",
        ErrorCodes.VALIDATION_FAILED,
        {
          taskId: "task-123",
        },
      );
      expect(error.name).toBe("TaskSystemError");
      expect(error.message).toBe("Test error");
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.context?.taskId).toEqual("task-123");
      expect(error.timestamp).toBeGreaterThan(0);
    });

    it("should include cause in error chain", () => {
      const cause = new Error("Original error");
      const error = new TaskSystemError(
        "Test error",
        ErrorCodes.VALIDATION_FAILED,
        undefined,
        cause,
      );

      expect(error.cause).toBe(cause);
    });

    it("should serialize to JSON", () => {
      const error = new TaskSystemError(
        "Test error",
        ErrorCodes.VALIDATION_FAILED,
        {
          taskId: "task-123",
        },
      );
      const json = error.toJSON();

      expect(json.name).toBe("TaskSystemError");
      expect(json.message).toBe("Test error");
      expect(json.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(json.context).toEqual({ taskId: "task-123" });
      expect(json.timestamp).toBeGreaterThan(0);
    });

    it("should serialize cause to JSON", () => {
      const cause = new Error("Original error");
      const error = new TaskSystemError(
        "Test error",
        ErrorCodes.VALIDATION_FAILED,
        undefined,
        cause,
      );
      const json = error.toJSON();
      expect(json.cause).toEqual({
        name: "Error",
        message: "Original error",
      });
    });
  });
  describe("ValidationError", () => {
    it("should create with field property", () => {
      const error = new ValidationError("Invalid name", "name");
      expect(error.name).toBe("ValidationError");
      expect(error.message).toBe("Invalid name");
      expect(error.field).toBe("name");
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });
  });
  describe("ConfigValidationError", () => {
    it("should create with configPath", () => {
      const error = new ConfigValidationError(
        "Invalid config",
        "executor.retry.maxAttempts",
      );

      expect(error.name).toBe("ConfigValidationError");
      expect(error.message).toBe("Invalid config");
      expect(error.configPath).toBe("executor.retry.maxAttempts");
      expect(error.code).toBe(ErrorCodes.CONFIG_VALIDATION_FAILED);
    });
  });

  describe("NotFoundError", () => {
    it("should create with resourceType task", () => {
      const error = new NotFoundError("Task not found", "task");
      expect(error.name).toBe("NotFoundError");
      expect(error.resourceType).toBe("task");
      expect(error.code).toBe(ErrorCodes.TASK_NOT_FOUND);
    });
    it("should create with resourceType template", () => {
      const error = new NotFoundError("Template not found", "template");
      expect(error.name).toBe("NotFoundError");
      expect(error.resourceType).toBe("template");
      expect(error.code).toBe(ErrorCodes.TEMPLATE_NOT_FOUND);
    });
    it("should create with resourceType handler", () => {
      const error = new NotFoundError("Handler not found", "handler");
      expect(error.name).toBe("NotFoundError");
      expect(error.resourceType).toBe("handler");
      expect(error.code).toBe(ErrorCodes.HANDLER_NOT_FOUND);
    });
  });

  describe("ConflictError", () => {
    it("should create conflict error", () => {
      const error = new ConflictError("Resource already exists");
      expect(error.name).toBe("ConflictError");
      expect(error.message).toBe("Resource already exists");
      expect(error.code).toBe(ErrorCodes.CONFLICT);
    });
  });

  describe("TaskStateError", () => {
    it("should create with currentState and attemptedTransition", () => {
      const error = new TaskStateError(
        "Invalid transition",
        "created",
        "completed",
        ["running", "cancelled"],
      );
      expect(error.name).toBe("TaskStateError");
      expect(error.currentState).toBe("created");
      expect(error.attemptedTransition).toBe("completed");
      expect(error.validTransitions).toEqual(["running", "cancelled"]);
      expect(error.code).toBe(ErrorCodes.INVALID_STATE_TRANSITION);
    });
  });

  describe("SlotTimeoutError", () => {
    it("should create with timeoutMs property", () => {
      const error = new SlotTimeoutError("Slot acquisition timeout", 5000);

      expect(error.name).toBe("SlotTimeoutError");
      expect(error.timeoutMs).toBe(5000);
      expect(error.code).toBe(ErrorCodes.SLOT_TIMEOUT);
    });
  });

  describe("BackpressureError", () => {
    it("should create with limit, remaining, and retryAfterMs", () => {
      const error = new BackpressureError(
        "Resource backpressure",
        100,
        50,
        5000,
      );

      expect(error.limit).toBe(100);
      expect(error.remaining).toBe(50);
      expect(error.retryAfterMs).toBe(5000);
      expect(error.code).toBe(ErrorCodes.BACKPRESSURE);
      expect(error.name).toBe("BackpressureError");
    });

    it("should convert to HTTP 429 response", () => {
      const error = new BackpressureError(
        "Resource backpressure",
        100,
        50,
        5000,
      );
      const response = error.toHTTPResponse();

      expect(response.status).toBe(429);
      expect(response.headers["Retry-After"]).toBe("5");
      expect(response.headers["X-RateLimit-Limit"]).toBe("100");
      expect(response.headers["X-RateLimit-Remaining"]).toBe("50");
      expect(response.body.error).toBe("TooManyRequests");
      expect(response.body.retryAfterMs).toBe(5000);
    });

    it("should use defaults in HTTP response when values not provided", () => {
      const error = new BackpressureError("Rate limit exceeded");
      const response = error.toHTTPResponse();

      expect(response.headers["Retry-After"]).toBe("1");
      expect(response.headers["X-RateLimit-Limit"]).toBe("0");
      expect(response.headers["X-RateLimit-Remaining"]).toBe("0");
      expect(response.body.retryAfterMs).toBe(1000);
    });
  });

  describe("InitializationError", () => {
    it("should create with component property", () => {
      const error = new InitializationError(
        "Failed to initialize",
        "DatabaseConnector",
      );

      expect(error.name).toBe("InitializationError");
      expect(error.component).toBe("DatabaseConnector");
      expect(error.code).toBe(ErrorCodes.INITIALIZATION_FAILED);
    });
  });

  describe("RetryExhaustedError", () => {
    it("should create with attempts and maxAttempts", () => {
      const cause = new Error("Final failure");
      const error = new RetryExhaustedError(
        "All retries exhausted",
        3,
        3,
        undefined,
        cause,
      );

      expect(error.name).toBe("RetryExhaustedError");
      expect(error.attempts).toBe(3);
      expect(error.maxAttempts).toBe(3);
      expect(error.cause).toBe(cause);
      expect(error.code).toBe(ErrorCodes.RETRY_EXHAUSTED);
    });
  });

  describe("StreamOverflowError", () => {
    it("should create stream overflow error", () => {
      const error = new StreamOverflowError("Buffer overflow", {
        idempotencyKey: "123",
      });

      expect(error.name).toBe("StreamOverflowError");
      expect(error.message).toBe("Buffer overflow");
      expect(error.context?.idempotencyKey).toBe("123");
      expect(error.code).toBe(ErrorCodes.STREAM_OVERFLOW);
    });
  });

  describe("isRetryableError", () => {
    it("should return true for BackpressureError", () => {
      expect(isRetryableError(new BackpressureError("Rate limited"))).toBe(
        true,
      );
    });
    it("should return true for SlotTimeoutError", () => {
      expect(isRetryableError(new SlotTimeoutError("Timeout"))).toBe(true);
    });
    it("should return false for ValidationError", () => {
      expect(isRetryableError(new ValidationError("Invalid"))).toBe(false);
    });
    it("should return false for NotFoundError", () => {
      expect(isRetryableError(new NotFoundError("Not found", "task"))).toBe(
        false,
      );
    });

    it("should return false for TaskStateError", () => {
      expect(isRetryableError(new TaskStateError("Invalid state"))).toBe(false);
    });

    it("should return false for ConfigValidationError", () => {
      expect(
        isRetryableError(new ConfigValidationError("Invalid config")),
      ).toBe(false);
    });
    it("should return false for ConflictError", () => {
      expect(isRetryableError(new ConflictError("Conflict"))).toBe(false);
    });
    it("should return false for RetryExhaustedError", () => {
      expect(isRetryableError(new RetryExhaustedError("Exhausted", 3, 3))).toBe(
        false,
      );
    });

    it("should return true for network-related errors", () => {
      expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
      expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
      expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
      expect(isRetryableError(new Error("socket hang up"))).toBe(true);
      expect(isRetryableError(new Error("network error"))).toBe(true);
    });

    it("should return false for permanent errors", () => {
      expect(isRetryableError(new Error("unauthorized"))).toBe(false);
      expect(isRetryableError(new Error("forbidden"))).toBe(false);
      expect(isRetryableError(new Error("invalid"))).toBe(false);
      expect(isRetryableError(new Error("not found"))).toBe(false);
      expect(isRetryableError(new Error("bad request"))).toBe(false);
    });

    it("should return true for unknown error (fail-safe default)", () => {
      expect(isRetryableError(new Error("Unknown error"))).toBe(true);
    });

    it("should return false for null/undefined", () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
    });

    it("should handle errors with HTTP status codes", () => {
      const error400 = Object.assign(new Error("Bad Request"), { status: 400 });
      const error404 = Object.assign(new Error("Not Found"), { status: 404 });
      const error429 = Object.assign(new Error("Too Many Requests"), {
        status: 429,
      });
      const error500 = Object.assign(new Error("Internal Server Error"), {
        status: 500,
      });
      const error503 = Object.assign(new Error("Service Unavailable"), {
        status: 503,
      });

      expect(isRetryableError(error400)).toBe(false);
      expect(isRetryableError(error404)).toBe(false);
      expect(isRetryableError(error429)).toBe(true);
      expect(isRetryableError(error500)).toBe(true);
      expect(isRetryableError(error503)).toBe(true);
    });
  });

  describe("isTaskSystemError", () => {
    it("should return true for TaskSystemError", () => {
      expect(isTaskSystemError(new TaskSystemError("Test error"))).toBe(true);
    });

    it("should return true for subclasses of TaskSystemError", () => {
      expect(isTaskSystemError(new BackpressureError("Rate limited"))).toBe(
        true,
      );
      expect(isTaskSystemError(new ValidationError("Invalid"))).toBe(true);
      expect(isTaskSystemError(new NotFoundError("Not found", "task"))).toBe(
        true,
      );
      expect(isTaskSystemError(new TaskStateError("Invalid state"))).toBe(true);
    });

    it("should return false for regular Error", () => {
      expect(isTaskSystemError(new Error("Test error"))).toBe(false);
    });

    it("should return false for non-error values", () => {
      expect(isTaskSystemError(null)).toBe(false);
      expect(isTaskSystemError(undefined)).toBe(false);
      expect(isTaskSystemError(123)).toBe(false);
      expect(isTaskSystemError("Test")).toBe(false);
      expect(isTaskSystemError({ message: "error" })).toBe(false);
    });
  });
});
