import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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
    // timeDimension/orderBy are omitted from the body.
    expect(JSON.parse(lastConnectArgs.payload)).toEqual({
      measures: ["revenue"],
      dimensions: ["region"],
      limit: 100,
    });
  });

  test("starts one request under React Strict Mode", () => {
    renderHook(
      () =>
        useMetricView("orders", {
          measures: ["revenue"],
          dimensions: ["region"],
        }),
      { wrapper: StrictMode },
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lastConnectArgs.payload)).toEqual({
      measures: ["revenue"],
      dimensions: ["region"],
    });
    expect(lastConnectArgs.signal.aborted).toBe(false);
  });

  test("still aborts the active request after a genuine unmount", async () => {
    const { unmount } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );
    const signal = lastConnectArgs.signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    unmount();

    await waitFor(() => expect(signal.aborted).toBe(true));
  });

  test("does not start until autoStart becomes true and keeps it out of the request body", () => {
    const { rerender } = renderHook(
      ({ autoStart }: { autoStart: boolean }) =>
        useMetricView("orders", {
          measures: ["revenue"],
          autoStart,
        }),
      { initialProps: { autoStart: false } },
    );

    expect(mockConnectSSE).not.toHaveBeenCalled();

    rerender({ autoStart: true });

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lastConnectArgs.payload)).toEqual({
      measures: ["revenue"],
    });
    expect(JSON.parse(lastConnectArgs.payload)).not.toHaveProperty("autoStart");
  });

  test("aborts an active request when autoStart becomes false", () => {
    const { rerender } = renderHook(
      ({ autoStart }: { autoStart: boolean }) =>
        useMetricView("orders", {
          measures: ["revenue"],
          autoStart,
        }),
      { initialProps: { autoStart: true } },
    );
    const signal = mockConnectSSE.mock.calls[0][0].signal as AbortSignal;

    expect(signal.aborted).toBe(false);

    rerender({ autoStart: false });

    expect(signal.aborted).toBe(true);
    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
  });

  test("serializes orderBy into the POST body when provided", () => {
    renderHook(() =>
      useMetricView("orders", {
        measures: ["revenue"],
        dimensions: ["region"],
        orderBy: [
          { field: "revenue", direction: "DESC" },
          { field: "region", direction: "ASC" },
        ],
      }),
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lastConnectArgs.payload)).toEqual({
      measures: ["revenue"],
      dimensions: ["region"],
      orderBy: [
        { field: "revenue", direction: "DESC" },
        { field: "region", direction: "ASC" },
      ],
    });
  });

  test("omits orderBy from the body when undefined", () => {
    renderHook(() =>
      useMetricView("orders", {
        measures: ["revenue"],
        dimensions: ["region"],
        orderBy: undefined,
      }),
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
    // orderBy must be absent from the body, not present-and-empty.
    expect(JSON.parse(lastConnectArgs.payload)).toEqual({
      measures: ["revenue"],
      dimensions: ["region"],
    });
    expect(JSON.parse(lastConnectArgs.payload)).not.toHaveProperty("orderBy");
  });

  test("refetches when orderBy changes", () => {
    const { rerender } = renderHook(
      ({ orderDir }: { orderDir: "ASC" | "DESC" }) =>
        useMetricView("orders", {
          measures: ["revenue"],
          orderBy: [{ field: "revenue", direction: orderDir }],
        }),
      { initialProps: { orderDir: "DESC" } },
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    rerender({ orderDir: "ASC" });

    expect(mockConnectSSE).toHaveBeenCalledTimes(2);
  });

  test("does not refetch when orderBy array is equal by value across renders", () => {
    const { rerender } = renderHook(
      ({ orderDir }: { orderDir: "DESC" }) =>
        useMetricView("orders", {
          measures: ["revenue"],
          orderBy: [{ field: "revenue", direction: orderDir }],
        }),
      { initialProps: { orderDir: "DESC" } },
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    rerender({ orderDir: "DESC" });
    rerender({ orderDir: "DESC" });

    // Structurally equal orderBy should not trigger a refetch because
    // the memo compares by JSON.stringify value, not object identity.
    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
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

  test("treats a non-object metadata (null/array) as absent", async () => {
    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({
          type: "result",
          data: [{ revenue: 1 }],
          // Malformed wire value — must not be surfaced as a metadata map.
          metadata: ["not", "an", "object"],
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([{ revenue: 1 }]);
    });
    expect(result.current.metadata).toBeUndefined();
  });

  test("a successful result after a transient error clears the stale error", async () => {
    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    // First: an error envelope sets error + errorCode.
    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({
          type: "error",
          error: "boom",
          errorCode: "UPSTREAM_ERROR",
        }),
      });
    });
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.errorCode).toBe("UPSTREAM_ERROR");

    // Then: a successful result must clear both, so error-first consumers show
    // the fresh data instead of the stale error.
    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({ type: "result", data: [{ revenue: 7 }] }),
      });
    });
    await waitFor(() => expect(result.current.data).toEqual([{ revenue: 7 }]));
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
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

  test("exposes the latest warehouse_status locally and publishes every status", async () => {
    const { result } = renderHook(() =>
      useMetricView("orders", { measures: ["revenue"] }),
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.warehouseStatus).toBeNull();
    // start() registers the slot with a null status (see the publish-only
    // side-channel) before any event arrives.
    expect(mockPublishWarehouseStatus).toHaveBeenCalledWith(null);

    const stopped = { state: "STOPPED", elapsedMs: 200 };
    const starting = { state: "STARTING", elapsedMs: 1200 };
    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({ type: "warehouse_status", status: stopped }),
      });
      lastConnectArgs.onMessage({
        data: JSON.stringify({ type: "warehouse_status", status: starting }),
      });
    });

    // The same event drives both per-hook feedback and the optional shared
    // provider's global "warehouse starting…" indicator.
    expect(mockPublishWarehouseStatus).toHaveBeenCalledWith(stopped);
    expect(mockPublishWarehouseStatus).toHaveBeenCalledWith(starting);
    expect(mockUnpublishWarehouseStatus).not.toHaveBeenCalled();
    expect(result.current.warehouseStatus).toEqual(starting);
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test("resets local warehouse status when a new request starts", () => {
    const { result, rerender } = renderHook(
      ({ region }: { region: string }) =>
        useMetricView("orders", {
          measures: ["revenue"],
          filter: { member: "region", operator: "equals", values: [region] },
        }),
      { initialProps: { region: "EMEA" } },
    );

    const status = { state: "STARTING", elapsedMs: 1200 };
    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({ type: "warehouse_status", status }),
      });
    });
    expect(result.current.warehouseStatus).toEqual(status);

    rerender({ region: "APAC" });

    expect(result.current.warehouseStatus).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(mockPublishWarehouseStatus).toHaveBeenLastCalledWith(null);
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

  test("preserves data and metadata while a filter change revalidates", async () => {
    const { result, rerender } = renderHook(
      ({ region }: { region: string }) =>
        useMetricView("orders", {
          measures: ["revenue"],
          dimensions: ["region"],
          filter: { member: "region", operator: "equals", values: [region] },
        }),
      { initialProps: { region: "EMEA" } },
    );
    const metadata = {
      revenue: { type: "DECIMAL", display_name: "Revenue" },
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
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ region: "APAC" });

    expect(mockConnectSSE).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual([{ revenue: 100, region: "EMEA" }]);
    expect(result.current.metadata).toEqual(metadata);
    expect(result.current.error).toBeNull();
  });

  test("clears data and metadata when selected columns change", async () => {
    const { result, rerender } = renderHook(
      ({ measure }: { measure: string }) =>
        useMetricView("orders", { measures: [measure] }),
      { initialProps: { measure: "revenue" } },
    );

    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({
          type: "result",
          data: [{ revenue: 100 }],
          metadata: { revenue: { type: "DECIMAL" } },
        }),
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ measure: "order_count" });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.metadata).toBeUndefined();
  });

  test("clears data and metadata when the metric key changes", async () => {
    const { result, rerender } = renderHook(
      ({ metricKey }: { metricKey: string }) =>
        useMetricView(metricKey, { measures: ["revenue"] }),
      { initialProps: { metricKey: "orders" } },
    );

    act(() => {
      lastConnectArgs.onMessage({
        data: JSON.stringify({
          type: "result",
          data: [{ revenue: 100 }],
          metadata: { revenue: { type: "DECIMAL" } },
        }),
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ metricKey: "customers" });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.metadata).toBeUndefined();
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

  test("throws when the metric key is empty", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      renderHook(() => useMetricView("", { measures: ["revenue"] })),
    ).toThrow(/must be a non-empty string/);

    errorSpy.mockRestore();
  });

  describe("aborted controller", () => {
    test("ignores a late warehouse_status envelope after the controller was aborted", async () => {
      const { result } = renderHook(() =>
        useMetricView("orders", { measures: ["revenue"] }),
      );

      await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());
      const publishCallsBefore = mockPublishWarehouseStatus.mock.calls.length;

      markAborted();

      act(() => {
        capturedCallbacks.onMessage?.({
          data: JSON.stringify({
            type: "warehouse_status",
            status: { state: "STARTING", elapsedMs: 1200 },
          }),
        });
      });

      expect(result.current.warehouseStatus).toBeNull();
      expect(mockPublishWarehouseStatus).toHaveBeenCalledTimes(
        publishCallsBefore,
      );
    });

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
