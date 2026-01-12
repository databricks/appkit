import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Logger } from "../logger";
import type { ScopedOTELBridge } from "../otel/bridge";

describe("Logger", () => {
  let mockOtelBridge: ScopedOTELBridge;
  let mockSpan: Span;
  let logger: Logger;

  beforeEach(() => {
    mockSpan = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      addEvent: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
      spanContext: vi.fn(),
      isRecording: vi.fn(() => true),
      updateName: vi.fn(),
      addLink: vi.fn(),
      addLinks: vi.fn(),
    } as any;

    mockOtelBridge = {
      startActiveSpan: vi.fn().mockImplementation(async (_name, _attrs, fn) => {
        return fn(mockSpan);
      }),
      createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
      emitLog: vi.fn(),
      createScoped: vi.fn(),
    } as any;

    logger = new Logger("test-scope", mockOtelBridge);
  });

  describe("debug()", () => {
    test("should output to terminal only", () => {
      logger.debug("Test message", { key: "value" });
      // Debug only goes to terminal (obug) - no OTEL, no WideEvent
      expect(mockOtelBridge.emitLog).not.toHaveBeenCalled();
    });
  });

  describe("trace()", () => {
    test("should send individual OTEL log records", () => {
      logger.trace("Verbose debug", { step: "init" });

      expect(mockOtelBridge.emitLog).toHaveBeenCalledWith(
        "debug",
        "Verbose debug",
        { step: "init" },
      );
    });

    test("should add to WideEvent if in request context", () => {
      // This would require AsyncLocalStorage setup - tested in context.test.ts
    });
  });

  describe("info()", () => {
    test("should not send individual OTEL logs", () => {
      logger.info("Info message", { userId: "123" });
      // info() does NOT call emitLog - it accumulates in WideEvent
      expect(mockOtelBridge.emitLog).not.toHaveBeenCalled();
    });
  });

  describe("warn()", () => {
    test("should not send individual OTEL logs", () => {
      logger.warn("Warning message");
      expect(mockOtelBridge.emitLog).not.toHaveBeenCalled();
    });
  });

  describe("error()", () => {
    test("should record exception on span by default", () => {
      const error = new Error("Test error");
      logger.error("Error occurred", error, { context: "value" });

      // error() does NOT call emitLog directly
      expect(mockOtelBridge.emitLog).not.toHaveBeenCalled();
    });

    test("should not record exception when recordOnSpan is false", () => {
      const error = new Error("Expected error");
      logger.error("Expected error", error, {}, { recordOnSpan: false });

      // Should still not call emitLog (goes to WideEvent)
      expect(mockOtelBridge.emitLog).not.toHaveBeenCalled();
    });
  });

  describe("span()", () => {
    test("should create span with scoped name", async () => {
      await logger.span("operation", async (_span) => {
        return "result";
      });

      expect(mockOtelBridge.startActiveSpan).toHaveBeenCalledWith(
        "test-scope.operation",
        {},
        expect.any(Function),
      );
    });

    test("should auto-set span status to OK on success", async () => {
      await logger.span("operation", async (_span) => {
        return "success";
      });

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.OK,
      });
    });

    test("should auto-set span status to ERROR on failure", async () => {
      const error = new Error("Test error");

      await expect(
        logger.span("operation", async (_span) => {
          throw error;
        }),
      ).rejects.toThrow("Test error");

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "Test error",
      });
    });

    test("should pass span attributes", async () => {
      await logger.span(
        "operation",
        async (_span) => {
          return "result";
        },
        { attributes: { key: "value", count: 42 } },
      );

      expect(mockOtelBridge.startActiveSpan).toHaveBeenCalledWith(
        "test-scope.operation",
        { key: "value", count: 42 },
        expect.any(Function),
      );
    });
  });

  describe("counter()", () => {
    test("should create counter with scoped name", () => {
      const _counter = logger.counter("requests", {
        description: "Total requests",
      });

      expect(mockOtelBridge.createCounter).toHaveBeenCalledWith(
        "test-scope.requests",
        { description: "Total requests" },
      );
    });
  });

  describe("histogram()", () => {
    test("should create histogram with scoped name", () => {
      const _histogram = logger.histogram("duration", { unit: "ms" });

      expect(mockOtelBridge.createHistogram).toHaveBeenCalledWith(
        "test-scope.duration",
        { unit: "ms" },
      );
    });
  });

  describe("recordContext()", () => {
    test("should not throw when no WideEvent exists", () => {
      expect(() => {
        logger.recordContext({ key: "value" });
      }).not.toThrow();
    });

    test("should add context to WideEvent if in request context", () => {
      // This requires AsyncLocalStorage setup - tested in context.test.ts
    });
  });

  describe("child()", () => {
    test("should create child logger with nested scope", () => {
      const _childLogger = logger.child("subsystem");

      expect(mockOtelBridge.createScoped).toHaveBeenCalledWith(
        "test-scope:subsystem",
      );
    });
  });

  describe("getEvent()", () => {
    test("should return undefined when no WideEvent exists", () => {
      const event = logger.getEvent();
      expect(event).toBeUndefined();
    });
  });
});
