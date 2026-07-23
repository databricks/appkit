import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let lastConnectArgs: any = null;
let capturedCallbacks: {
  onMessage?: (msg: { data: string }) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
} = {};

// Mock connectSSE so the hook does not attempt a real network request.
// Capture both the full args (used by the payload/refetch tests) and the
// individual callbacks/signal (used by the result/error and late-envelope
// tests). The hook ignores the return value.
const mockConnectSSE = vi.fn((args: any): unknown => {
  lastConnectArgs = args;
  capturedCallbacks = {
    onMessage: args?.onMessage,
    onError: args?.onError,
    signal: args?.signal,
  };
  return () => {};
});

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...(args as [any])),
  ArrowClient: {},
}));

vi.mock("../use-query-hmr", () => ({
  useQueryHMR: vi.fn(),
}));

// Mock the warehouse-status publisher so we can observe the publish-only
// side-channel (useMetricView surfaces warehouse readiness ONLY by publishing
// to the ResourceStatusProvider — it never adds a field to its result). The
// two spies are stable across renders, mirroring the real hook's useCallback
// contract, so start()'s identity doesn't churn.
const mockPublishWarehouseStatus = vi.fn();
const mockUnpublishWarehouseStatus = vi.fn();
vi.mock("../use-analytics-warehouse-status", () => ({
  useAnalyticsWarehousePublisher: () => ({
    publish: mockPublishWarehouseStatus,
    unpublish: mockUnpublishWarehouseStatus,
  }),
}));

import { useMetricView } from "../use-metric-view";

function markAborted() {
  const sig = capturedCallbacks.signal;
  if (!sig) throw new Error("signal not captured yet");
  Object.defineProperty(sig, "aborted", { value: true, configurable: true });
}

describe("useMetricView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastConnectArgs = null;
    capturedCallbacks = {};
    mockPublishWarehouseStatus.mockClear();
    mockUnpublishWarehouseStatus.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("POSTs the metric route with only the defined body fields on mount", () => {
    renderHook(() =>
      useMetricView("orders", {
        measures: ["revenue"],
        dimensions: ["region"],
        limit: 100,
      }),
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
    expect(String(lastConnectArgs.url)).toContain(
      "/api/analytics/metric/orders",
    );
    // Only defined fields are serialized — undefined filter/timeGrain/
    // timeDimension are omitted from the body.
    expect(JSON.parse(lastConnectArgs.payload)).toEqual({
      measures: ["revenue"],
      dimensions: ["region"],
      limit: 100,
    });
  });

  test("surfaces a type:result payload as data and reads its per-column metadata", async () => {
    const { result } = renderHook(() =>
      useMetricView("orders", {
        measures: ["revenue"],
        dimensions: ["region"],
      }),
    );

    const metadata = {
      revenue: { type: "DECIMAL", display_name: "Revenue", format: "currency" },
      region: { type: "STRING", display_name: "Region" },
    };

    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({
          type: "result",
          data: [{ revenue: 100, region: "EMEA" }],
          metadata,
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([{ revenue: 100, region: "EMEA" }]);
    });
    expect(result.current.metadata).toEqual(metadata);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("leaves metadata undefined when the result payload omits it", async () => {
    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({ type: "result", data: [{ revenue: 1 }] }),
      });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([{ revenue: 1 }]);
    });
    expect(result.current.metadata).toBeUndefined();
  });

  test("normalizes an empty result message (no data field) to []", async () => {
    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    act(() => {
      lastConnectArgs.onMessage({ data: JSON.stringify({ type: "result" }) });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("publishes warehouse_status to the resource provider without exposing it on the result", async () => {
    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    expect(result.current.loading).toBe(true);
    // start() registers the slot with a null status (see the publish-only
    // side-channel) before any event arrives.
    expect(mockPublishWarehouseStatus).toHaveBeenCalledWith(null);

    const status = { state: "STARTING", elapsedMs: 1200 };
    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({ type: "warehouse_status", status }),
      });
    });

    // The event is published to the shared provider (driving a global
    // "warehouse starting…" indicator) but the metric result shape does NOT
    // expose warehouseStatus (Phase 0 contract) and the hook stays loading.
    expect(mockPublishWarehouseStatus).toHaveBeenCalledWith(status);
    expect(mockUnpublishWarehouseStatus).not.toHaveBeenCalled();
    expect(result.current).not.toHaveProperty("warehouseStatus");
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test("unpublishes warehouse status once the result arrives", async () => {
    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "STARTING", elapsedMs: 500 },
        }),
      });
    });
    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({ type: "result", data: [{ revenue: 1 }] }),
      });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([{ revenue: 1 }]);
    });
    // The indicator must clear once the warehouse is ready and rows land.
    expect(mockUnpublishWarehouseStatus).toHaveBeenCalled();
  });

  test("a malformed warehouse_status event errors and unpublishes rather than publishing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    // Baseline publish(null) from start(); a malformed event must not publish
    // a status on top of it.
    const publishCallsBefore = mockPublishWarehouseStatus.mock.calls.length;

    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({ type: "warehouse_status" }),
      });
    });

    await waitFor(() => {
      expect(result.current.error).toBe(
        "Unable to load data, please try again",
      );
    });
    expect(result.current.loading).toBe(false);
    expect(mockPublishWarehouseStatus.mock.calls.length).toBe(
      publishCallsBefore,
    );
    expect(mockUnpublishWarehouseStatus).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("a server error event exposes both the message and the structured errorCode", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({
          type: "error",
          error: "Metric view is not defined",
          code: "UPSTREAM_ERROR",
          errorCode: "UNKNOWN_METRIC_KEY",
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Metric view is not defined");
    });
    expect(result.current.errorCode).toBe("UNKNOWN_METRIC_KEY");
    expect(result.current.loading).toBe(false);

    errorSpy.mockRestore();
  });

  test("a malformed (non-JSON) SSE payload clears loading and surfaces an error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    act(() => {
      lastConnectArgs.onMessage({ data: "not-json{" });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe("Unable to load data, please try again");
    expect(result.current.data).toBeNull();

    warnSpy.mockRestore();
  });

  test("maps an onError network failure to a user-facing message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    act(() => {
      lastConnectArgs.onError(new Error("Failed to fetch"));
    });

    await waitFor(() => {
      expect(result.current.error).toBe(
        "Network error. Please check your connection.",
      );
    });
    expect(result.current.loading).toBe(false);

    errorSpy.mockRestore();
  });

  test("does not refetch when the options are structurally equal across renders", () => {
    const { rerender } = renderHook(
      ({ region }: { region: string }) =>
        useMetricView("orders", {
          measures: ["revenue"],
          dimensions: ["region"],
          filter: { member: "region", operator: "equals", values: [region] },
        }),
      { initialProps: { region: "EMEA" } },
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    rerender({ region: "EMEA" });
    rerender({ region: "EMEA" });

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
  });

  test("refetches and aborts the prior stream when a measure changes", () => {
    const { rerender } = renderHook(
      ({ measure }: { measure: string }) =>
        useMetricView("orders", { measures: [measure] }),
      { initialProps: { measure: "revenue" } },
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
    const firstSignal = mockConnectSSE.mock.calls[0][0].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    rerender({ measure: "order_count" });

    expect(mockConnectSSE).toHaveBeenCalledTimes(2);
    // The prior request's controller was aborted before the new one started.
    expect(firstSignal.aborted).toBe(true);
    expect(JSON.parse(mockConnectSSE.mock.calls[1][0].payload)).toEqual({
      measures: ["order_count"],
    });
  });

  test("refetches when the filter changes", () => {
    const { rerender } = renderHook(
      ({ region }: { region: string }) =>
        useMetricView("orders", {
          measures: ["revenue"],
          filter: { member: "region", operator: "equals", values: [region] },
        }),
      { initialProps: { region: "EMEA" } },
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    rerender({ region: "APAC" });

    expect(mockConnectSSE).toHaveBeenCalledTimes(2);
  });

  test("refetches when the timeGrain changes", () => {
    const { rerender } = renderHook(
      ({ grain }: { grain: string }) =>
        useMetricView("orders", {
          measures: ["revenue"],
          dimensions: ["order_date"],
          timeDimension: "order_date",
          timeGrain: grain,
        }),
      { initialProps: { grain: "day" } },
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    rerender({ grain: "month" });

    expect(mockConnectSSE).toHaveBeenCalledTimes(2);
  });

  test("does not issue a request when autoStart is false", () => {
    renderHook(() =>
      useMetricView("orders", { measures: ["revenue"], autoStart: false }),
    );

    expect(mockConnectSSE).not.toHaveBeenCalled();
  });

  test("throws when the metric key is empty", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      renderHook(() => useMetricView("", { measures: ["revenue"] })),
    ).toThrow(/must be a non-empty string/);

    errorSpy.mockRestore();
  });

  describe("aborted controller", () => {
    test("ignores a late result envelope after the controller was aborted", async () => {
      const { result } = renderHook(() =>
        useMetricView("orders", { measures: ["revenue"] }),
      );

      await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());

      markAborted();

      act(() => {
        capturedCallbacks.onMessage?.({
          data: JSON.stringify({ type: "result", data: [{ revenue: 99 }] }),
        });
      });

      expect(result.current.data).toBeNull();
    });

    test("ignores a late error envelope after the controller was aborted", async () => {
      const { result } = renderHook(() =>
        useMetricView("orders", { measures: ["revenue"] }),
      );

      await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());

      markAborted();

      act(() => {
        capturedCallbacks.onMessage?.({
          data: JSON.stringify({
            type: "error",
            error: "The operation was aborted.",
            code: "UPSTREAM_ERROR",
          }),
        });
      });

      expect(result.current.error).toBeNull();
    });
  });
});
