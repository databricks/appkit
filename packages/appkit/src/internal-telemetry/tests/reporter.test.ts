import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TelemetryReporter } from "../reporter";

type RequestSpy = ReturnType<typeof vi.fn>;

function createMockClient(): {
  client: WorkspaceClient;
  request: RequestSpy;
} {
  const request = vi.fn().mockResolvedValue({});
  const client = { apiClient: { request } } as unknown as WorkspaceClient;
  return { client, request };
}

function baseOpts(): {
  workspaceId: string;
  client: WorkspaceClient;
  appId: string;
  appkitVersion: string;
  heartbeatIntervalMs: number;
  metricsFlushIntervalMs: number;
  __spy: RequestSpy;
} {
  const { client, request } = createMockClient();
  return {
    workspaceId: "1234567890",
    client,
    appId: "app-uuid-1",
    appkitVersion: "0.27.0",
    heartbeatIntervalMs: 1_000_000,
    metricsFlushIntervalMs: 1_000_000,
    __spy: request,
  };
}

afterEach(() => {
  TelemetryReporter._reset();
  vi.restoreAllMocks();
});

function lastProtoLog(spy: RequestSpy, callIndex = -1) {
  const calls = spy.mock.calls;
  const idx = callIndex < 0 ? calls.length + callIndex : callIndex;
  const payload = calls[idx][0].payload as { protoLogs: string[] };
  return JSON.parse(payload.protoLogs[0]);
}

describe("TelemetryReporter", () => {
  test("getInstance returns null before initialize", () => {
    expect(TelemetryReporter.getInstance()).toBeNull();
  });

  test("sendStartup emits an APP_STARTUP appkit_log via apiClient.request", async () => {
    const opts = baseOpts();
    const reporter = TelemetryReporter.initialize(opts);
    await reporter.sendStartup();

    expect(opts.__spy).toHaveBeenCalledOnce();
    const reqArg = opts.__spy.mock.calls[0][0];
    expect(reqArg).toMatchObject({
      path: "/telemetry-ext",
      method: "POST",
      query: { o: "1234567890" },
      raw: false,
    });
    expect(lastProtoLog(opts.__spy).entry.appkit_log).toMatchObject({
      event_name: "APP_STARTUP",
      app_id: "app-uuid-1",
      appkit_version: "0.27.0",
      app_startup_event: {},
    });
  });

  test("sendHeartbeat emits a HEARTBEAT appkit_log", async () => {
    const opts = baseOpts();
    const reporter = TelemetryReporter.initialize(opts);
    await reporter.sendHeartbeat();

    expect(lastProtoLog(opts.__spy).entry.appkit_log).toMatchObject({
      event_name: "HEARTBEAT",
      heartbeat_event: {},
    });
  });

  test("recordRequest aggregates by method+route and flush sends one log per endpoint", async () => {
    const opts = baseOpts();
    const reporter = TelemetryReporter.initialize(opts);
    reporter.recordRequest("GET", "/api/x", 200, 100);
    reporter.recordRequest("get", "/api/x", 200, 200);
    reporter.recordRequest("GET", "/api/x", 500, 50);
    reporter.recordRequest("POST", "/api/y", 404, 10);

    await reporter.flushRequestMetrics();

    expect(opts.__spy).toHaveBeenCalledOnce();
    const protoLogs = opts.__spy.mock.calls[0][0].payload.protoLogs as string[];
    expect(protoLogs).toHaveLength(2);

    const events = protoLogs
      .map((s) => JSON.parse(s).entry.appkit_log.request_metrics_event)
      .sort((a, b) => a.endpoint.localeCompare(b.endpoint));

    expect(events[0]).toEqual({
      endpoint: "GET /api/x",
      request_count: 3,
      request_latency_ms_avg: 117, // (100 + 200 + 50) / 3 = 116.67 -> 117
      response_count_http4xx: 0,
      response_count_http5xx: 1,
    });
    expect(events[1]).toEqual({
      endpoint: "POST /api/y",
      request_count: 1,
      request_latency_ms_avg: 10,
      response_count_http4xx: 1,
      response_count_http5xx: 0,
    });
  });

  test("flushRequestMetrics is a no-op when there are no buckets", async () => {
    const opts = baseOpts();
    const reporter = TelemetryReporter.initialize(opts);
    await reporter.flushRequestMetrics();
    expect(opts.__spy).not.toHaveBeenCalled();
  });

  test("flushRequestMetrics drains the aggregator after sending", async () => {
    const opts = baseOpts();
    const reporter = TelemetryReporter.initialize(opts);
    reporter.recordRequest("GET", "/api/x", 200, 10);
    await reporter.flushRequestMetrics();
    opts.__spy.mockClear();
    await reporter.flushRequestMetrics();
    expect(opts.__spy).not.toHaveBeenCalled();
  });

  test("recordRequest ignores entries without a route template", async () => {
    const opts = baseOpts();
    const reporter = TelemetryReporter.initialize(opts);
    reporter.recordRequest("GET", "", 200, 10);
    await reporter.flushRequestMetrics();
    expect(opts.__spy).not.toHaveBeenCalled();
  });

  test("start schedules heartbeat and metrics flush; stop clears them", () => {
    vi.useFakeTimers();
    const reporter = TelemetryReporter.initialize({
      ...baseOpts(),
      heartbeatIntervalMs: 1_000,
      metricsFlushIntervalMs: 500,
    });
    const heartbeatSpy = vi
      .spyOn(reporter, "sendHeartbeat")
      .mockResolvedValue();
    const flushSpy = vi
      .spyOn(reporter, "flushRequestMetrics")
      .mockResolvedValue();

    reporter.start();
    vi.advanceTimersByTime(1_500);
    expect(heartbeatSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(3);

    reporter.stop();
    vi.advanceTimersByTime(5_000);
    expect(heartbeatSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  test("propagates request errors so callers can surface them", async () => {
    const opts = baseOpts();
    opts.__spy.mockRejectedValue(new Error("network down"));
    const reporter = TelemetryReporter.initialize(opts);
    await expect(reporter.sendHeartbeat()).rejects.toThrow("network down");
  });

  test("propagates a rejecting workspaceId promise", async () => {
    const opts = baseOpts();
    const reporter = TelemetryReporter.initialize({
      ...opts,
      workspaceId: Promise.reject(new Error("nope")),
    });
    await expect(reporter.sendHeartbeat()).rejects.toThrow("nope");
    expect(opts.__spy).not.toHaveBeenCalled();
  });

  test("interval timers swallow rejections silently", async () => {
    vi.useFakeTimers();
    const opts = baseOpts();
    opts.__spy.mockRejectedValue(new Error("network down"));
    const reporter = TelemetryReporter.initialize({
      ...opts,
      heartbeatIntervalMs: 100,
      metricsFlushIntervalMs: 1_000_000,
    });
    reporter.start();
    await vi.advanceTimersByTimeAsync(150);
    // No unhandled rejection means the timer's outer .catch worked.
    reporter.stop();
    vi.useRealTimers();
  });

  test("re-initialize stops the previous instance's timers", () => {
    vi.useFakeTimers();
    const first = TelemetryReporter.initialize({
      ...baseOpts(),
      heartbeatIntervalMs: 100,
      metricsFlushIntervalMs: 100,
    });
    const firstHeartbeat = vi.spyOn(first, "sendHeartbeat").mockResolvedValue();
    first.start();

    TelemetryReporter.initialize({
      ...baseOpts(),
      heartbeatIntervalMs: 1_000_000,
      metricsFlushIntervalMs: 1_000_000,
    });

    vi.advanceTimersByTime(500);
    // The first reporter's timers must have been cleared by the re-init.
    expect(firstHeartbeat).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
