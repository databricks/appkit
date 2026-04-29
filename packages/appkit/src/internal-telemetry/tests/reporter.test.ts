import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TelemetryReporter } from "../reporter";

function createMockClient(): WorkspaceClient {
  return {
    config: {
      authenticate: vi.fn(async (headers: Headers) => {
        headers.set("Authorization", "Bearer mock-sp-token");
      }),
    },
  } as unknown as WorkspaceClient;
}

const baseOpts = () => ({
  workspaceHost: "https://my-workspace.cloud.databricks.com",
  workspaceId: "1234567890",
  client: createMockClient(),
  appId: "app-uuid-1",
  appkitVersion: "0.27.0",
  heartbeatIntervalMs: 1_000_000,
  metricsFlushIntervalMs: 1_000_000,
});

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  TelemetryReporter._reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function lastProtoLog() {
  const calls = fetchSpy.mock.calls;
  const [, options] = calls[calls.length - 1];
  const body = JSON.parse(options.body as string);
  return JSON.parse(body.protoLogs[0]);
}

describe("TelemetryReporter", () => {
  test("getInstance returns null before initialize", () => {
    expect(TelemetryReporter.getInstance()).toBeNull();
  });

  test("sendStartup emits an APP_STARTUP appkit_log", async () => {
    const reporter = TelemetryReporter.initialize(baseOpts());
    await reporter.sendStartup();

    const log = lastProtoLog();
    expect(log.entry.appkit_log).toMatchObject({
      event_name: "APP_STARTUP",
      app_id: "app-uuid-1",
      appkit_version: "0.27.0",
      app_startup_event: { placeholder: true },
    });
  });

  test("sendHeartbeat emits a HEARTBEAT appkit_log", async () => {
    const reporter = TelemetryReporter.initialize(baseOpts());
    await reporter.sendHeartbeat();

    const log = lastProtoLog();
    expect(log.entry.appkit_log).toMatchObject({
      event_name: "HEARTBEAT",
      heartbeat_event: { placeholder: true },
    });
  });

  test("recordRequest aggregates by method+route and flush sends one log per endpoint", async () => {
    const reporter = TelemetryReporter.initialize(baseOpts());
    reporter.recordRequest("GET", "/api/x", 200, 100);
    reporter.recordRequest("get", "/api/x", 200, 200);
    reporter.recordRequest("GET", "/api/x", 500, 50);
    reporter.recordRequest("POST", "/api/y", 404, 10);

    await reporter.flushRequestMetrics();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0];
    const protoLogs = JSON.parse(options.body as string).protoLogs as string[];
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
    const reporter = TelemetryReporter.initialize(baseOpts());
    await reporter.flushRequestMetrics();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("flushRequestMetrics drains the aggregator after sending", async () => {
    const reporter = TelemetryReporter.initialize(baseOpts());
    reporter.recordRequest("GET", "/api/x", 200, 10);
    await reporter.flushRequestMetrics();
    fetchSpy.mockClear();
    await reporter.flushRequestMetrics();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("recordRequest ignores entries without a route template", async () => {
    const reporter = TelemetryReporter.initialize(baseOpts());
    reporter.recordRequest("GET", "", 200, 10);
    await reporter.flushRequestMetrics();
    expect(fetchSpy).not.toHaveBeenCalled();
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
      .mockResolvedValue(null);
    const flushSpy = vi
      .spyOn(reporter, "flushRequestMetrics")
      .mockResolvedValue(null);

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

  test("propagates fetch errors so callers can surface them", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const reporter = TelemetryReporter.initialize(baseOpts());
    await expect(reporter.sendHeartbeat()).rejects.toThrow("network down");
  });

  test("propagates a rejecting workspaceId promise", async () => {
    const reporter = TelemetryReporter.initialize({
      ...baseOpts(),
      workspaceId: Promise.reject(new Error("nope")),
    });
    await expect(reporter.sendHeartbeat()).rejects.toThrow("nope");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("interval timers swallow rejections silently", async () => {
    vi.useFakeTimers();
    fetchSpy.mockRejectedValue(new Error("network down"));
    const reporter = TelemetryReporter.initialize({
      ...baseOpts(),
      heartbeatIntervalMs: 100,
      metricsFlushIntervalMs: 1_000_000,
    });
    reporter.start();
    await vi.advanceTimersByTimeAsync(150);
    // No unhandled rejection means the timer's outer .catch worked.
    reporter.stop();
    vi.useRealTimers();
  });

  test("returns dispatched request and response from sendStartup", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    const reporter = TelemetryReporter.initialize(baseOpts());
    const result = await reporter.sendStartup();
    expect(result?.request.method).toBe("POST");
    expect(result?.response.status).toBe(200);
  });
});
