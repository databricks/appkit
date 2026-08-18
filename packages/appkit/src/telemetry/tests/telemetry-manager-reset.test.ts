import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Re-bootability coverage for TelemetryManager.
 *
 * `_initialize` returns early without building an SDK when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so nothing about the shutdown path is
 * observable in the default test environment. These tests set the endpoint and
 * mock `NodeSDK` so repeated initialize/shutdown cycles can be asserted.
 *
 * The plan behind this work claimed a bug here — that a never-cleared
 * `shutdownPromise` made a second `shutdown()` return the first call's stale
 * promise and skip flushing a re-initialized SDK. That claim does not hold, and
 * the first test is what disproves it: `shutdown()` only returns the memo after
 * reassigning it for whatever SDK is currently live, so a stale promise can be
 * returned only when there is no SDK to flush. The behaviour is asserted here so
 * a future "cleanup" of that memo cannot silently change it.
 */

const { sdkShutdown, NodeSDKMock } = vi.hoisted(() => {
  const sdkShutdown = vi.fn().mockResolvedValue(undefined);
  const NodeSDKMock = vi.fn(() => ({
    start: vi.fn(),
    shutdown: sdkShutdown,
  }));
  return { sdkShutdown, NodeSDKMock };
});

vi.mock("@opentelemetry/sdk-node", () => ({ NodeSDK: NodeSDKMock }));
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
  return { ...actual, detectResources: vi.fn(() => actual.emptyResource()) };
});

import { TelemetryManager } from "../telemetry-manager";

describe("TelemetryManager re-bootability", () => {
  let originalEndpoint: string | undefined;

  beforeEach(() => {
    originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    vi.clearAllMocks();
    TelemetryManager.reset();
  });

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    }
    TelemetryManager.reset();
  });

  test("shutdown() twice across a re-initialize() flushes both SDKs", async () => {
    TelemetryManager.initialize({});
    const manager = TelemetryManager.getInstance();
    expect(NodeSDKMock).toHaveBeenCalledTimes(1);

    await manager.shutdown();
    expect(sdkShutdown).toHaveBeenCalledTimes(1);

    // Re-initialize builds a *new* SDK, because shutdown() cleared `sdk`.
    TelemetryManager.initialize({});
    expect(NodeSDKMock).toHaveBeenCalledTimes(2);

    await manager.shutdown();
    expect(sdkShutdown).toHaveBeenCalledTimes(2);

    // A third cycle, to pin the general property rather than one transition.
    TelemetryManager.initialize({});
    await manager.shutdown();
    expect(NodeSDKMock).toHaveBeenCalledTimes(3);
    expect(sdkShutdown).toHaveBeenCalledTimes(3);
  });

  test("concurrent shutdown() calls share one flush", async () => {
    TelemetryManager.initialize({});
    const manager = TelemetryManager.getInstance();

    await Promise.all([manager.shutdown(), manager.shutdown()]);

    // Clearing `sdk` synchronously is what makes this safe: the second caller
    // finds no SDK and awaits the first caller's memo.
    expect(sdkShutdown).toHaveBeenCalledTimes(1);
  });

  test("shutdown() with no SDK built resolves without flushing", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    TelemetryManager.initialize({});
    const manager = TelemetryManager.getInstance();

    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(sdkShutdown).not.toHaveBeenCalled();
  });

  test("reset() drops the singleton so the next getInstance() is fresh", () => {
    const first = TelemetryManager.getInstance();
    TelemetryManager.reset();
    const second = TelemetryManager.getInstance();

    expect(second).not.toBe(first);
  });
});
