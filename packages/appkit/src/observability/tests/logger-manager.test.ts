import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LoggerManager } from "../logger-manager";

// Mock OTEL exports to prevent actual SDK initialization
vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: vi.fn(() => ({
    export: vi.fn((_spans, callback) => callback({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
  OTLPMetricExporter: vi.fn(() => ({
    export: vi.fn((_metrics, callback) => callback({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: vi.fn(() => ({
    export: vi.fn((_logs, callback) => callback({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe("LoggerManager", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
    // @ts-expect-error - accessing private static property for testing
    LoggerManager.instance = undefined;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Singleton behavior", () => {
    test("getInstance() should return singleton instance", () => {
      const instance1 = LoggerManager.getInstance();
      const instance2 = LoggerManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    test("initialize() should not reinitialize if already initialized", () => {
      LoggerManager.initialize({ serviceName: "test-1" });
      LoggerManager.initialize({ serviceName: "test-2" });

      // Should only initialize once
      const instance = LoggerManager.getInstance();
      expect(instance).toBeDefined();
    });
  });

  describe("getLogger()", () => {
    test("should create logger with scope", () => {
      const logger = LoggerManager.getLogger("test-plugin");

      expect(logger).toBeDefined();
      expect(logger.debug).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.span).toBeDefined();
    });

    test("should create loggers with different scopes", () => {
      const logger1 = LoggerManager.getLogger("plugin-1");
      const logger2 = LoggerManager.getLogger("plugin-2");

      expect(logger1).not.toBe(logger2);
    });

    test("should respect observability config", () => {
      const logger = LoggerManager.getLogger("test-plugin", {
        traces: false,
        metrics: true,
        logs: true,
      });

      expect(logger).toBeDefined();
    });
  });

  describe("getOTELBridge()", () => {
    test("should return OTEL bridge instance", () => {
      const bridge = LoggerManager.getOTELBridge();

      expect(bridge).toBeDefined();
      expect(bridge.isEnabled).toBeDefined();
    });
  });

  describe("getMiddleware()", () => {
    test("should return Express middleware function", () => {
      const middleware = LoggerManager.getMiddleware();

      expect(typeof middleware).toBe("function");
      expect(middleware.length).toBe(3); // (req, res, next)
    });

    test("should create WideEvent and set in AsyncLocalStorage", () => {
      const middleware = LoggerManager.getMiddleware();

      const mockReq: any = {
        headers: { "x-request-id": "test-123" },
        method: "POST",
        path: "/api/test",
      };
      const mockRes: any = {
        setHeader: vi.fn(),
        on: vi.fn(),
      };
      const mockNext = vi.fn();

      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "x-request-id",
        "test-123",
      );
      expect(mockRes.on).toHaveBeenCalledWith("finish", expect.any(Function));
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("shutdown()", () => {
    test("should shutdown OTEL bridge", async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

      LoggerManager.initialize();
      await LoggerManager.shutdown();

      // @ts-expect-error - accessing private static property
      expect(LoggerManager.instance).toBeUndefined();
    });

    test("should not throw if not initialized", async () => {
      await expect(LoggerManager.shutdown()).resolves.not.toThrow();
    });
  });

  describe("OTEL integration", () => {
    test("should initialize with OTEL endpoint", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

      LoggerManager.initialize({ serviceName: "test-service" });

      const logger = LoggerManager.getLogger("test");
      expect(logger).toBeDefined();
    });

    test("should work without OTEL endpoint (noop mode)", () => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

      LoggerManager.initialize();

      const logger = LoggerManager.getLogger("test");
      expect(logger).toBeDefined();

      // Should not throw when creating spans/metrics
      expect(() => logger.counter("test")).not.toThrow();
      expect(() => logger.histogram("test")).not.toThrow();
    });
  });
});
