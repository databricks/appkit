import { NOOP_LOGGER } from "@opentelemetry/api-logs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NOOP_METER, NOOP_TRACER } from "../src/noop";
import type { TelemetryManager } from "../src/telemetry-manager";
import { TelemetryProvider } from "../src/telemetry-provider";

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: vi.fn(),
  },
  metrics: {
    getMeter: vi.fn(),
  },
  SpanStatusCode: {
    OK: 0,
    ERROR: 2,
  },
  createNoopMeter: vi.fn(() => ({})),
}));

vi.mock("@opentelemetry/api-logs", () => ({
  NOOP_LOGGER: {
    emit: vi.fn(),
  },
  logs: {
    getLogger: vi.fn(),
  },
}));

describe("TelemetryProvider", () => {
  let mockManager: TelemetryManager;
  let mockTracer: any;
  let mockMeter: any;
  let mockLogger: any;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    mockManager = {
      registerInstrumentations: vi.fn(),
    } as any;

    mockTracer = {
      startActiveSpan: vi.fn(),
      startSpan: vi.fn(),
    };

    mockMeter = {
      createCounter: vi.fn(),
      createHistogram: vi.fn(),
    };

    mockLogger = {
      emit: vi.fn(),
    };

    const { trace } = await import("@opentelemetry/api");
    const { logs } = await import("@opentelemetry/api-logs");
    const { metrics } = await import("@opentelemetry/api");

    vi.mocked(trace.getTracer).mockReturnValue(mockTracer);
    vi.mocked(metrics.getMeter).mockReturnValue(mockMeter);
    vi.mocked(logs.getLogger).mockReturnValue(mockLogger);
  });

  test("should return NOOP_TRACER when traces disabled", () => {
    const telemetry = new TelemetryProvider("test-plugin", mockManager, {
      traces: false,
      metrics: true,
      logs: true,
    });

    const tracer = telemetry.getTracer();

    expect(tracer).toBe(NOOP_TRACER);
  });

  test("should return NOOP_METER when metrics disabled", () => {
    const telemetry = new TelemetryProvider("test-plugin", mockManager, {
      traces: true,
      metrics: false,
      logs: true,
    });

    const meter = telemetry.getMeter();

    expect(meter).toBe(NOOP_METER);
  });

  test("should return NOOP_LOGGER when logs disabled", () => {
    const telemetry = new TelemetryProvider("test-plugin", mockManager, {
      traces: true,
      metrics: true,
      logs: false,
    });

    const logger = telemetry.getLogger();

    expect(logger).toBe(NOOP_LOGGER);
  });

  test("should return real tracer from OpenTelemetry API when enabled", async () => {
    const { trace } = await import("@opentelemetry/api");
    const telemetry = new TelemetryProvider("test-plugin", mockManager);

    const tracer = telemetry.getTracer();

    expect(trace.getTracer).toHaveBeenCalledWith("test-plugin");
    expect(tracer).toBe(mockTracer);
  });

  test("should return real meter from OpenTelemetry API when enabled", async () => {
    const { metrics } = await import("@opentelemetry/api");
    const telemetry = new TelemetryProvider("test-plugin", mockManager);

    const meter = telemetry.getMeter();

    expect(metrics.getMeter).toHaveBeenCalledWith("test-plugin");
    expect(meter).toBe(mockMeter);
  });

  test("should return real logger from OpenTelemetry API when enabled", async () => {
    const { logs } = await import("@opentelemetry/api-logs");
    const telemetry = new TelemetryProvider("test-plugin", mockManager);

    const logger = telemetry.getLogger();

    expect(logs.getLogger).toHaveBeenCalledWith("test-plugin");
    expect(logger).toBe(mockLogger);
  });

  test("should use plugin name as default instrument name", async () => {
    const { trace } = await import("@opentelemetry/api");
    const telemetry = new TelemetryProvider("my-plugin", mockManager);

    telemetry.getTracer();

    expect(trace.getTracer).toHaveBeenCalledWith("my-plugin");
  });

  test("should include prefix when includePrefix is true", async () => {
    const { trace } = await import("@opentelemetry/api");
    const telemetry = new TelemetryProvider("my-plugin", mockManager);

    telemetry.getTracer({ name: "custom", includePrefix: true });

    expect(trace.getTracer).toHaveBeenCalledWith("my-plugin-custom");
  });

  test("should use custom name without prefix when includePrefix is false", async () => {
    const { trace } = await import("@opentelemetry/api");
    const telemetry = new TelemetryProvider("my-plugin", mockManager);

    telemetry.getTracer({ name: "custom", includePrefix: false });

    expect(trace.getTracer).toHaveBeenCalledWith("custom");
  });

  test("should use custom name without prefix when includePrefix is not specified", async () => {
    const { trace } = await import("@opentelemetry/api");
    const telemetry = new TelemetryProvider("my-plugin", mockManager);

    telemetry.getTracer({ name: "custom" });

    expect(trace.getTracer).toHaveBeenCalledWith("custom");
  });

  test("should delegate startActiveSpan to tracer", async () => {
    const telemetry = new TelemetryProvider("test-plugin", mockManager);
    const mockSpan = { end: vi.fn() };
    const callback = vi.fn().mockResolvedValue("result");

    mockTracer.startActiveSpan.mockImplementation(
      async (_name: string, _options: any, fn: any) => {
        return fn(mockSpan);
      },
    );

    const result = await telemetry.startActiveSpan(
      "test-span",
      { attributes: { key: "value" } },
      callback,
    );

    expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
      "test-span",
      { attributes: { key: "value" } },
      callback,
    );
    expect(result).toBe("result");
  });

  test("should delegate registerInstrumentations to global manager", () => {
    const telemetry = new TelemetryProvider("test-plugin", mockManager);
    const instrumentations = [{ name: "test-instrumentation" }] as any;

    telemetry.registerInstrumentations(instrumentations);

    expect(mockManager.registerInstrumentations).toHaveBeenCalledWith(
      instrumentations,
    );
  });

  test("should not register instrumentations when traces disabled", () => {
    const telemetry = new TelemetryProvider("test-plugin", mockManager, {
      traces: false,
      metrics: true,
      logs: true,
    });
    const instrumentations = [{ name: "test-instrumentation" }] as any;

    telemetry.registerInstrumentations(instrumentations);

    expect(mockManager.registerInstrumentations).not.toHaveBeenCalled();
  });

  test("should call logger.emit() in emit method", () => {
    const telemetry = new TelemetryProvider("test-plugin", mockManager);
    const logRecord = {
      body: "test log message",
      severityNumber: 9,
    } as any;

    telemetry.emit(logRecord);

    expect(mockLogger.emit).toHaveBeenCalledWith(logRecord);
  });

  test("should handle emit when logs are disabled", () => {
    const telemetry = new TelemetryProvider("test-plugin", mockManager, {
      traces: true,
      metrics: true,
      logs: false,
    });
    const logRecord = {
      body: "test log message",
      severityNumber: 9,
    } as any;

    expect(() => telemetry.emit(logRecord)).not.toThrow();
  });
});
