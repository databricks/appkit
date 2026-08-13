import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TelemetryManager } from "../telemetry-manager";

const { mockNodeSdkStart, mockNodeSdkShutdown } = vi.hoisted(() => ({
  mockNodeSdkStart: vi.fn(),
  mockNodeSdkShutdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn(function (this: Record<string, unknown>) {
    this.start = mockNodeSdkStart;
    this.shutdown = mockNodeSdkShutdown;
  }),
}));

// Mock only exporters to prevent network calls
vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: vi.fn(() => ({
    export: vi.fn((_spans, callback) => callback({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
  OTLPMetricExporter: vi.fn(() => ({
    export: vi.fn((_metrics, callback) => callback({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: vi.fn(() => ({
    export: vi.fn((_logs, callback) => callback({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock resource detection to avoid env complexity
vi.mock("@opentelemetry/resources", async () => {
  const actual = await vi.importActual<
    typeof import("@opentelemetry/resources")
  >("@opentelemetry/resources");
  return {
    ...actual,
    detectResources: vi.fn(() => {
      return actual.resourceFromAttributes({
        "host.name": "test-host",
      });
    }),
  };
});

// Mock auto-instrumentations to avoid side effects
vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: vi.fn(() => []),
}));

describe("TelemetryManager", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
    mockNodeSdkStart.mockImplementation(() => undefined);
    mockNodeSdkShutdown.mockResolvedValue(undefined);
    // @ts-expect-error - accessing private static property for testing
    TelemetryManager.instance = undefined;
    // @ts-expect-error - accessing private static property for testing
    TelemetryManager.shutdownRegistered = false;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("getInstance() should return singleton instance", () => {
    const instance1 = TelemetryManager.getInstance();
    const instance2 = TelemetryManager.getInstance();

    expect(instance1).toBe(instance2);
  });

  test("should call detectResources when initializing", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const { detectResources } = await import("@opentelemetry/resources");
    vi.clearAllMocks();

    await TelemetryManager.initialize({
      serviceName: "test-service-config",
    });

    expect(detectResources).toHaveBeenCalled();
  });

  test("should initialize providers and create telemetry instances", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    await TelemetryManager.initialize({
      serviceName: "integration-test",
      serviceVersion: "1.0.0",
    });

    const telemetryProvider = TelemetryManager.getProvider("test-plugin");
    const tracer = telemetryProvider.getTracer();
    const meter = telemetryProvider.getMeter();
    const logger = telemetryProvider.getLogger();

    expect(tracer).toBeDefined();
    expect(meter).toBeDefined();
    expect(logger).toBeDefined();

    expect(() =>
      tracer.startActiveSpan("test.span", {}, async (span) => {
        span.setAttribute("test.attribute", "test-value");
        span.setAttribute("test.number", 42);
        span.addEvent("test.event", { eventData: "some-data" });
        span.end();
        return "test-result";
      }),
    ).not.toThrow();
    expect(() => meter.createCounter("integration.counter")).not.toThrow();
    expect(() => meter.createHistogram("integration.histogram")).not.toThrow();
    expect(() =>
      logger.emit({ body: "test-log", severityNumber: 9 }),
    ).not.toThrow();
  });

  test("should support disabled telemetry config", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";

    await TelemetryManager.initialize({
      serviceName: "disabled-test",
      serviceVersion: "1.0.0",
    });

    const telemetryProvider = TelemetryManager.getProvider("disabled-plugin", {
      traces: false,
      metrics: false,
      logs: false,
    });

    const tracer = telemetryProvider.getTracer();
    const meter = telemetryProvider.getMeter();
    const logger = telemetryProvider.getLogger();

    expect(tracer).toBeDefined();
    expect(meter).toBeDefined();
    expect(logger).toBeDefined();

    expect(() =>
      tracer.startActiveSpan("test.span", {}, async (span) => {
        span.setAttribute("test.attribute", "test-value");
        span.setAttribute("test.number", 42);
        span.addEvent("test.event", { eventData: "some-data" });
        span.end();
        return "test-result";
      }),
    ).not.toThrow();
    expect(() => meter.createCounter("integration.counter")).not.toThrow();
    expect(() => meter.createHistogram("integration.histogram")).not.toThrow();
    expect(() =>
      logger.emit({ body: "test-log", severityNumber: 9 }),
    ).not.toThrow();
  });

  test("should pass headers to exporters", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-proto"
    );
    vi.clearAllMocks();

    await TelemetryManager.initialize({
      headers: {
        Authorization: "Bearer token",
        "Custom-Header": "value",
      },
    });

    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          Authorization: "Bearer token",
          "Custom-Header": "value",
        },
      }),
    );
  });

  describe("startActiveSpan", () => {
    test("should create and execute spans with real tracer", async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

      await TelemetryManager.initialize({
        serviceName: "span-test",
        serviceVersion: "1.0.0",
      });

      const telemetryProvider =
        TelemetryManager.getProvider("span-test-plugin");
      const tracer = telemetryProvider.getTracer();

      let spanWasExecuted = false;
      await tracer.startActiveSpan("test.span", {}, async (span) => {
        span.setAttribute("test.attribute", "test-value");
        span.setAttribute("test.number", 42);
        span.addEvent("test.event", { eventData: "some-data" });
        span.end();
        spanWasExecuted = true;
        return "test-result";
      });

      expect(spanWasExecuted).toBe(true);
    });

    test("should handle span errors", async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

      await TelemetryManager.initialize({
        serviceName: "error-test",
        serviceVersion: "1.0.0",
      });

      const telemetryProvider =
        TelemetryManager.getProvider("error-test-plugin");
      const testError = new Error("Test error in span");

      await expect(
        telemetryProvider.startActiveSpan("failing.span", {}, async (span) => {
          span.setAttribute("will.fail", true);
          throw testError;
        }),
      ).rejects.toThrow("Test error in span");
    });
  });

  test("starts the single AppKit provider for valid UC config without generic OTLP", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.MLFLOW_EXPERIMENT_ID = "123456789";
    process.env.MLFLOW_UC_CATALOG = "main";
    process.env.MLFLOW_UC_SCHEMA = "agent_traces";
    process.env.MLFLOW_UC_TABLE_PREFIX = "appkit";
    process.env.MLFLOW_OTEL_SPANS_TABLE = "main.agent_traces.appkit_otel_spans";

    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    await TelemetryManager.initialize({ mlflowUc: true });

    expect(NodeSDK).toHaveBeenCalledTimes(1);
    expect(vi.mocked(NodeSDK).mock.calls[0][0]).toMatchObject({
      spanProcessors: [expect.anything()],
      metricReaders: [],
      logRecordProcessors: [],
    });
    expect(mockNodeSdkStart).toHaveBeenCalledTimes(1);
  });

  test("coexists with generic OTLP on the same AppKit provider", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.MLFLOW_EXPERIMENT_ID = "123456789";
    process.env.MLFLOW_UC_CATALOG = "main";
    process.env.MLFLOW_UC_SCHEMA = "agent_traces";
    process.env.MLFLOW_UC_TABLE_PREFIX = "appkit";
    process.env.MLFLOW_OTEL_SPANS_TABLE = "main.agent_traces.appkit_otel_spans";

    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    await TelemetryManager.initialize({ mlflowUc: true });

    expect(NodeSDK).toHaveBeenCalledTimes(1);
    expect(vi.mocked(NodeSDK).mock.calls[0]?.[0]?.spanProcessors).toHaveLength(
      2,
    );
  });

  test("rejects missing UC configuration before starting the provider", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.MLFLOW_EXPERIMENT_ID;
    delete process.env.MLFLOW_UC_CATALOG;
    delete process.env.MLFLOW_UC_SCHEMA;
    delete process.env.MLFLOW_UC_TABLE_PREFIX;
    delete process.env.MLFLOW_OTEL_SPANS_TABLE;

    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    await expect(
      TelemetryManager.initialize({ mlflowUc: true }),
    ).rejects.toThrow("MLflow UC tracing configuration missing:");
    expect(NodeSDK).not.toHaveBeenCalled();
    expect(mockNodeSdkStart).not.toHaveBeenCalled();
  });

  test("propagates provider startup failures", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    mockNodeSdkStart.mockImplementation(() => {
      throw new Error("provider start failed");
    });

    await expect(TelemetryManager.initialize()).rejects.toThrow(
      "provider start failed",
    );
  });
});
