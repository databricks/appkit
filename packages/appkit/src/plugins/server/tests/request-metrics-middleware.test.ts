import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TelemetryReporter } from "../../../internal-telemetry";
import { requestMetricsMiddleware } from "../index";

interface FakeRequest {
  method: string;
  baseUrl?: string;
  route?: { path: string } | undefined;
}

interface FakeResponse {
  statusCode: number;
  on: (event: string, handler: () => void) => void;
  finish: () => void;
}

function makeReq(opts: FakeRequest): FakeRequest {
  return { ...opts };
}

function makeRes(statusCode = 200): FakeResponse {
  let finishHandler: (() => void) | null = null;
  return {
    statusCode,
    on(event, handler) {
      if (event === "finish") finishHandler = handler;
    },
    finish() {
      finishHandler?.();
    },
  };
}

describe("requestMetricsMiddleware", () => {
  let reporter: TelemetryReporter;
  let recordSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reporter = TelemetryReporter.initialize({
      workspaceId: "ws-1",
      client: {
        apiClient: { request: vi.fn().mockResolvedValue({}) },
      } as any,
      appId: "app-1",
      appkitVersion: "0.0.0",
      heartbeatIntervalMs: 1_000_000,
      metricsFlushIntervalMs: 1_000_000,
    });
    recordSpy = vi.spyOn(reporter, "recordRequest");
  });

  afterEach(() => {
    TelemetryReporter._reset();
    vi.restoreAllMocks();
  });

  test("calls next() so the request continues", () => {
    const next = vi.fn();
    requestMetricsMiddleware(
      makeReq({ method: "GET", route: { path: "/x" } }) as any,
      makeRes() as any,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  test("records (METHOD baseUrl+route, status, latency) on finish", () => {
    const req = makeReq({
      method: "post",
      baseUrl: "/api/users",
      route: { path: "/:id/messages" },
    });
    const res = makeRes(201);
    requestMetricsMiddleware(req as any, res as any, vi.fn());

    res.finish();

    expect(recordSpy).toHaveBeenCalledOnce();
    const [method, template, statusCode, latency] = recordSpy.mock.calls[0];
    expect(method).toBe("post");
    expect(template).toBe("/api/users/:id/messages");
    expect(statusCode).toBe(201);
    expect(typeof latency).toBe("number");
    expect(latency).toBeGreaterThanOrEqual(0);
  });

  test("falls back to empty baseUrl when not on a sub-router", () => {
    const req = makeReq({ method: "GET", route: { path: "/health" } });
    const res = makeRes();
    requestMetricsMiddleware(req as any, res as any, vi.fn());
    res.finish();
    expect(recordSpy.mock.calls.at(-1)?.[1]).toBe("/health");
  });

  test("skips recording when no route was matched (no req.route)", () => {
    const req = makeReq({ method: "GET", route: undefined });
    const res = makeRes(404);
    requestMetricsMiddleware(req as any, res as any, vi.fn());
    res.finish();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  test("is a no-op when the reporter is not initialized", () => {
    TelemetryReporter._reset();
    const req = makeReq({ method: "GET", route: { path: "/x" } });
    const res = makeRes();
    const next = vi.fn();
    requestMetricsMiddleware(req as any, res as any, next);
    res.finish();
    expect(next).toHaveBeenCalledOnce();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  test("forwards 4xx and 5xx status codes intact", () => {
    const req = makeReq({ method: "GET", route: { path: "/x" } });
    const res4xx = makeRes(404);
    requestMetricsMiddleware(req as any, res4xx as any, vi.fn());
    res4xx.finish();
    const res5xx = makeRes(503);
    requestMetricsMiddleware(req as any, res5xx as any, vi.fn());
    res5xx.finish();

    expect(recordSpy.mock.calls[0][2]).toBe(404);
    expect(recordSpy.mock.calls[1][2]).toBe(503);
  });
});
