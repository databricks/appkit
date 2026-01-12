import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OTELBridge, ScopedOTELBridge } from "../bridge";

// Mock OTEL SDK
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto");
vi.mock("@opentelemetry/exporter-metrics-otlp-proto");
vi.mock("@opentelemetry/exporter-logs-otlp-proto");

describe("OTELBridge", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Initialization", () => {
    test("should initialize when OTEL endpoint is configured", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

      const bridge = new OTELBridge({ serviceName: "test-service" });

      expect(bridge.isEnabled()).toBe(true);
    });

    test("should not initialize when OTEL endpoint is missing", () => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

      const bridge = new OTELBridge();

      expect(bridge.isEnabled()).toBe(false);
    });

    test("should respect enabled: false config", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

      const bridge = new OTELBridge({ enabled: false });

      expect(bridge.isEnabled()).toBe(false);
    });
  });

  describe("createScoped()", () => {
    test("should create scoped bridge with scope name", () => {
      const bridge = new OTELBridge();
      const scoped = bridge.createScoped("test-plugin");

      expect(scoped).toBeInstanceOf(ScopedOTELBridge);
    });

    test("should pass observability options to scoped bridge", () => {
      const bridge = new OTELBridge();
      const scoped = bridge.createScoped("test-plugin", {
        traces: false,
        metrics: true,
      });

      expect(scoped).toBeDefined();
    });
  });

  describe("shutdown()", () => {
    test("should shutdown SDK", async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

      const bridge = new OTELBridge();
      await bridge.shutdown();

      // Should not throw
    });

    test("should handle shutdown when SDK not initialized", async () => {
      const bridge = new OTELBridge();
      await expect(bridge.shutdown()).resolves.not.toThrow();
    });
  });
});

describe("ScopedOTELBridge", () => {
  let mockBridge: OTELBridge;
  let mockTracer: any;
  let mockMeter: any;

  beforeEach(() => {
    mockTracer = {
      startActiveSpan: vi.fn(),
    };

    mockMeter = {
      createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    };

    mockBridge = {
      isEnabled: vi.fn().mockReturnValue(true),
      getTracer: vi.fn().mockReturnValue(mockTracer),
      getMeter: vi.fn().mockReturnValue(mockMeter),
      getLogger: vi.fn().mockReturnValue({ emit: vi.fn() }),
    } as any;
  });

  describe("Observability options", () => {
    test("should enable all by default when bridge is enabled", () => {
      const scoped = new ScopedOTELBridge("test", mockBridge);

      scoped.createCounter("test");
      scoped.createHistogram("test");

      expect(mockMeter.createCounter).toHaveBeenCalled();
      expect(mockMeter.createHistogram).toHaveBeenCalled();
    });

    test("should respect boolean config", () => {
      const scoped = new ScopedOTELBridge("test", mockBridge, false);

      const _counter = scoped.createCounter("test");
      const _histogram = scoped.createHistogram("test");

      // Should return noop instances
      expect(mockMeter.createCounter).not.toHaveBeenCalled();
      expect(mockMeter.createHistogram).not.toHaveBeenCalled();
    });

    test("should respect granular config", () => {
      const scoped = new ScopedOTELBridge("test", mockBridge, {
        traces: true,
        metrics: false,
        logs: true,
      });

      scoped.createCounter("test");
      expect(mockMeter.createCounter).not.toHaveBeenCalled(); // metrics disabled
    });
  });

  describe("startActiveSpan()", () => {
    test("should create span when traces enabled", async () => {
      const scoped = new ScopedOTELBridge("test", mockBridge, { traces: true });

      mockTracer.startActiveSpan.mockImplementation(
        (_name: string, _opts: any, fn: any) => {
          const mockSpan = {
            end: vi.fn(),
            setAttribute: vi.fn(),
            setStatus: vi.fn(),
          };
          return fn(mockSpan);
        },
      );

      await scoped.startActiveSpan("test-span", {}, async (_span) => {
        return "result";
      });

      expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
        "test-span",
        { attributes: {} },
        expect.any(Function),
      );
    });

    test("should return noop span when traces disabled", async () => {
      const scoped = new ScopedOTELBridge("test", mockBridge, {
        traces: false,
      });

      const result = await scoped.startActiveSpan("test", {}, async (span) => {
        expect(span.isRecording()).toBe(false);
        return "result";
      });

      expect(result).toBe("result");
      expect(mockTracer.startActiveSpan).not.toHaveBeenCalled();
    });
  });

  describe("createCounter()", () => {
    test("should create counter with scoped name", () => {
      const scoped = new ScopedOTELBridge("test-plugin", mockBridge);

      scoped.createCounter("requests", { description: "Total requests" });

      expect(mockMeter.createCounter).toHaveBeenCalledWith("requests", {
        unit: undefined,
        description: "Total requests",
      });
    });

    test("should return noop counter when metrics disabled", () => {
      const scoped = new ScopedOTELBridge("test", mockBridge, {
        metrics: false,
      });

      const counter = scoped.createCounter("test");

      expect(mockMeter.createCounter).not.toHaveBeenCalled();
      expect(() => counter.add(1)).not.toThrow();
    });
  });

  describe("createHistogram()", () => {
    test("should create histogram with options", () => {
      const scoped = new ScopedOTELBridge("test-plugin", mockBridge);

      scoped.createHistogram("duration", { unit: "ms" });

      expect(mockMeter.createHistogram).toHaveBeenCalledWith("duration", {
        unit: "ms",
        description: undefined,
      });
    });

    test("should return noop histogram when metrics disabled", () => {
      const scoped = new ScopedOTELBridge("test", mockBridge, {
        metrics: false,
      });

      const histogram = scoped.createHistogram("test");

      expect(mockMeter.createHistogram).not.toHaveBeenCalled();
      expect(() => histogram.record(100)).not.toThrow();
    });
  });

  describe("createScoped()", () => {
    test("should create nested scoped bridge", () => {
      const scoped = new ScopedOTELBridge("parent", mockBridge);
      const child = scoped.createScoped("child");

      expect(child).toBeInstanceOf(ScopedOTELBridge);
    });
  });

  describe("emitLog()", () => {
    test("should emit log when logs enabled", () => {
      const mockLogger = { emit: vi.fn() };
      mockBridge.getLogger = vi.fn().mockReturnValue(mockLogger);

      const scoped = new ScopedOTELBridge("test", mockBridge, { logs: true });

      scoped.emitLog("info", "Test message", { key: "value" });

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: "Test message",
        severityNumber: expect.any(Number),
        attributes: { key: "value" },
      });
    });

    test("should not emit log when logs disabled", () => {
      const scoped = new ScopedOTELBridge("test", mockBridge, { logs: false });

      scoped.emitLog("info", "Test message");

      expect(mockBridge.getLogger).not.toHaveBeenCalled();
    });
  });
});
