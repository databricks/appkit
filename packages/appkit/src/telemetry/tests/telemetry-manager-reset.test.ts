import { context, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Telemetry now builds three providers — the meter and logger in `initialize()`,
 * the tracer in `start()` — instead of a single `NodeSDK`. These mock the three
 * provider constructors so the shutdown/flush path is observable, and set an OTLP
 * endpoint so `initialize()` actually builds the meter/logger providers.
 *
 * The never-cleared `shutdownPromise` was suspected of skipping a re-booted
 * provider set's flush. It does not — the memo is reassigned whenever providers
 * are live. Re-boot goes through `reset()` (what `dropCoreSingletons()` does
 * between harness boots), because `initialize()`/`start()` are idempotent within
 * one manager: they guard on `resource`/`started`, which `shutdown()` deliberately
 * does not clear. A bare re-`initialize()` after `shutdown()` is therefore a no-op.
 */

const {
  meterProviderShutdown,
  loggerProviderShutdown,
  tracerProviderShutdown,
  MeterProviderMock,
  LoggerProviderMock,
  NodeTracerProviderMock,
} = vi.hoisted(() => {
  const meterProviderShutdown = vi.fn().mockResolvedValue(undefined);
  const loggerProviderShutdown = vi.fn().mockResolvedValue(undefined);
  const tracerProviderShutdown = vi.fn().mockResolvedValue(undefined);
  return {
    meterProviderShutdown,
    loggerProviderShutdown,
    tracerProviderShutdown,
    MeterProviderMock: vi.fn(() => ({ shutdown: meterProviderShutdown })),
    LoggerProviderMock: vi.fn(() => ({ shutdown: loggerProviderShutdown })),
    NodeTracerProviderMock: vi.fn(() => ({
      register: vi.fn(),
      shutdown: tracerProviderShutdown,
    })),
  };
});

vi.mock("@opentelemetry/sdk-metrics", () => ({
  MeterProvider: MeterProviderMock,
  PeriodicExportingMetricReader: vi.fn(() => ({})),
}));
vi.mock("@opentelemetry/sdk-logs", () => ({
  LoggerProvider: LoggerProviderMock,
  BatchLogRecordProcessor: vi.fn(() => ({})),
}));
vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: NodeTracerProviderMock,
}));
// Keep the real module (AppKitSampler needs SamplingDecision); only stub the
// span processor so no real exporter/timer is wired up.
vi.mock("@opentelemetry/sdk-trace-base", async () => {
  const actual = await vi.importActual<
    typeof import("@opentelemetry/sdk-trace-base")
  >("@opentelemetry/sdk-trace-base");
  return { ...actual, BatchSpanProcessor: vi.fn(() => ({})) };
});
vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: vi.fn(() => []),
}));
vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: vi.fn(() => ({})),
}));
vi.mock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
  OTLPMetricExporter: vi.fn(() => ({})),
}));
vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: vi.fn(() => ({})),
}));
vi.mock("@opentelemetry/resources", async () => {
  const actual = await vi.importActual<
    typeof import("@opentelemetry/resources")
  >("@opentelemetry/resources");
  return {
    ...actual,
    detectResources: vi.fn(() => actual.resourceFromAttributes({})),
  };
});

import { TelemetryManager } from "../telemetry-manager";

/** Reset the singleton and clear any globals a prior boot registered. */
function resetTelemetry(): void {
  TelemetryManager.reset();
  metrics.disable();
  logs.disable();
  trace.disable();
  context.disable();
}

describe("TelemetryManager re-bootability", () => {
  let originalEndpoint: string | undefined;

  beforeEach(() => {
    originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    vi.clearAllMocks();
    resetTelemetry();
  });

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    }
    resetTelemetry();
  });

  test("a reset() between boots rebuilds and re-flushes every provider", async () => {
    // Boot 1: initialize() builds the meter + logger providers, start() the tracer.
    TelemetryManager.initialize({});
    TelemetryManager.start();
    expect(MeterProviderMock).toHaveBeenCalledTimes(1);
    expect(LoggerProviderMock).toHaveBeenCalledTimes(1);
    expect(NodeTracerProviderMock).toHaveBeenCalledTimes(1);

    await TelemetryManager.getInstance().shutdown();
    expect(meterProviderShutdown).toHaveBeenCalledTimes(1);
    expect(loggerProviderShutdown).toHaveBeenCalledTimes(1);
    expect(tracerProviderShutdown).toHaveBeenCalledTimes(1);

    // Re-boot the way the harness does — reset() (dropCoreSingletons) then boot.
    // A bare re-initialize() would be a no-op here (see the file header).
    resetTelemetry();

    TelemetryManager.initialize({});
    TelemetryManager.start();
    expect(MeterProviderMock).toHaveBeenCalledTimes(2);
    expect(NodeTracerProviderMock).toHaveBeenCalledTimes(2);

    await TelemetryManager.getInstance().shutdown();
    expect(meterProviderShutdown).toHaveBeenCalledTimes(2);
    expect(loggerProviderShutdown).toHaveBeenCalledTimes(2);
    expect(tracerProviderShutdown).toHaveBeenCalledTimes(2);

    // A third cycle, to pin the general property rather than one transition.
    resetTelemetry();
    TelemetryManager.initialize({});
    TelemetryManager.start();
    await TelemetryManager.getInstance().shutdown();
    expect(MeterProviderMock).toHaveBeenCalledTimes(3);
    expect(meterProviderShutdown).toHaveBeenCalledTimes(3);
    expect(tracerProviderShutdown).toHaveBeenCalledTimes(3);
  });

  test("concurrent shutdown() calls share one flush", async () => {
    TelemetryManager.initialize({});
    TelemetryManager.start();
    const manager = TelemetryManager.getInstance();

    await Promise.all([manager.shutdown(), manager.shutdown()]);

    // Clearing the provider refs synchronously is what makes this safe: the
    // second caller finds no providers and awaits the first caller's memo.
    expect(meterProviderShutdown).toHaveBeenCalledTimes(1);
    expect(loggerProviderShutdown).toHaveBeenCalledTimes(1);
    expect(tracerProviderShutdown).toHaveBeenCalledTimes(1);
  });

  test("shutdown() with no providers built resolves without flushing", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    TelemetryManager.initialize({});
    TelemetryManager.start();
    const manager = TelemetryManager.getInstance();

    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(meterProviderShutdown).not.toHaveBeenCalled();
    expect(loggerProviderShutdown).not.toHaveBeenCalled();
    expect(tracerProviderShutdown).not.toHaveBeenCalled();
  });

  test("reset() drops the singleton so the next getInstance() is fresh", () => {
    const first = TelemetryManager.getInstance();
    TelemetryManager.reset();
    const second = TelemetryManager.getInstance();

    expect(second).not.toBe(first);
  });
});
