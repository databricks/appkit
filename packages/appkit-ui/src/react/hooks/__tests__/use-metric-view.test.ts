import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { clearMetricsMetadata } from "@/format";

// Mock connectSSE — capture callbacks so we can simulate SSE events.
let capturedCallbacks: {
  onMessage?: (msg: { data: string }) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
} = {};

const mockConnectSSE = vi.fn().mockImplementation((opts: any) => {
  capturedCallbacks = {
    onMessage: opts.onMessage,
    onError: opts.onError,
    signal: opts.signal,
  };
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
});

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

import { useMetricView } from "../use-metric-view";

describe("useMetricView", () => {
  afterEach(() => {
    capturedCallbacks = {};
    vi.clearAllMocks();
    clearMetricsMetadata();
  });

  test("initial state is loading=true with autoStart (default)", () => {
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );

    expect(result.current.data).toBeNull();
    // autoStart triggers connect synchronously inside useEffect, so
    // loading flips to true before the test inspects state.
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    // Phase 5: metadata is null when no bundle has been registered.
    expect(result.current.metadata).toBeNull();
  });

  test("connects to /api/analytics/metric/<key> with the request payload", () => {
    renderHook(() => useMetricView("revenue", { measures: ["arr"] }));

    expect(mockConnectSSE).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/api/analytics/metric/revenue",
        payload: JSON.stringify({
          measures: ["arr"],
          format: "JSON",
        }),
      }),
    );
  });

  test("includes limit in the payload when provided", () => {
    renderHook(() =>
      useMetricView("revenue", { measures: ["arr"], limit: 10 }),
    );

    const payload = JSON.parse(
      (mockConnectSSE.mock.calls[0][0] as any).payload,
    );
    expect(payload).toEqual({
      measures: ["arr"],
      limit: 10,
      format: "JSON",
    });
  });

  // ── Phase 2: dimensions + timeGrain payload assembly ────────────────────
  test("includes dimensions in the payload when non-empty", () => {
    renderHook(() =>
      useMetricView("revenue", {
        measures: ["arr"],
        dimensions: ["region", "segment"],
      }),
    );

    const payload = JSON.parse(
      (mockConnectSSE.mock.calls[0][0] as any).payload,
    );
    expect(payload).toEqual({
      measures: ["arr"],
      dimensions: ["region", "segment"],
      format: "JSON",
    });
  });

  test("omits dimensions from the payload when empty (ungrouped query)", () => {
    renderHook(() =>
      useMetricView("revenue", { measures: ["arr"], dimensions: [] }),
    );

    const payload = JSON.parse(
      (mockConnectSSE.mock.calls[0][0] as any).payload,
    );
    expect(payload).toEqual({
      measures: ["arr"],
      format: "JSON",
    });
    expect(payload.dimensions).toBeUndefined();
  });

  test("includes timeGrain in the payload when provided", () => {
    renderHook(() =>
      useMetricView("revenue", {
        measures: ["arr"],
        dimensions: ["created_at"],
        timeGrain: "month",
      }),
    );

    const payload = JSON.parse(
      (mockConnectSSE.mock.calls[0][0] as any).payload,
    );
    expect(payload).toEqual({
      measures: ["arr"],
      dimensions: ["created_at"],
      timeGrain: "month",
      format: "JSON",
    });
  });

  test("combines dimensions, timeGrain, and limit in the payload", () => {
    renderHook(() =>
      useMetricView("revenue", {
        measures: ["arr", "mrr"],
        dimensions: ["created_at"],
        timeGrain: "week",
        limit: 50,
      }),
    );

    const payload = JSON.parse(
      (mockConnectSSE.mock.calls[0][0] as any).payload,
    );
    expect(payload).toEqual({
      measures: ["arr", "mrr"],
      dimensions: ["created_at"],
      timeGrain: "week",
      limit: 50,
      format: "JSON",
    });
  });

  // ── Phase 3: filter payload assembly ─────────────────────────────────────
  test("includes a leaf Predicate filter in the payload", () => {
    renderHook(() =>
      useMetricView("revenue", {
        measures: ["arr"],
        dimensions: ["region"],
        filter: {
          member: "region",
          operator: "equals",
          values: ["EMEA"],
        },
      } as any),
    );

    const payload = JSON.parse(
      (mockConnectSSE.mock.calls[0][0] as any).payload,
    );
    expect(payload.filter).toEqual({
      member: "region",
      operator: "equals",
      values: ["EMEA"],
    });
  });

  test("preserves recursive { and: [...] } filter structure verbatim", () => {
    const filter = {
      and: [
        { member: "region", operator: "in", values: ["EMEA", "APAC"] },
        { member: "segment", operator: "equals", values: ["Enterprise"] },
      ],
    };
    renderHook(() =>
      useMetricView("revenue", {
        measures: ["arr"],
        filter,
      } as any),
    );

    const payload = JSON.parse(
      (mockConnectSSE.mock.calls[0][0] as any).payload,
    );
    expect(payload.filter).toEqual(filter);
  });

  test("preserves deeply-nested OR-of-AND structure", () => {
    const filter = {
      or: [
        {
          and: [
            { member: "region", operator: "equals", values: ["EMEA"] },
            { member: "segment", operator: "equals", values: ["Enterprise"] },
          ],
        },
        { member: "region", operator: "equals", values: ["APAC"] },
      ],
    };
    renderHook(() =>
      useMetricView("revenue", {
        measures: ["arr"],
        filter,
      } as any),
    );

    const payload = JSON.parse(
      (mockConnectSSE.mock.calls[0][0] as any).payload,
    );
    expect(payload.filter).toEqual(filter);
  });

  test("omits filter from the payload when not provided", () => {
    renderHook(() => useMetricView("revenue", { measures: ["arr"] }));
    const payload = JSON.parse(
      (mockConnectSSE.mock.calls[0][0] as any).payload,
    );
    expect(payload.filter).toBeUndefined();
  });

  test("populates data on a result event", async () => {
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );

    act(() => {
      capturedCallbacks.onMessage?.({
        data: JSON.stringify({
          type: "result",
          data: [{ arr: 1234567 }],
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual([{ arr: 1234567 }]);
    expect(result.current.error).toBeNull();
  });

  test("sets error on a server error event", async () => {
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );

    act(() => {
      capturedCallbacks.onMessage?.({
        data: JSON.stringify({
          type: "error",
          error: "Bad measures",
          code: "VALIDATION_ERROR",
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe("Bad measures");
    expect(result.current.data).toBeNull();
  });

  test("surfaces a network failure via onError", async () => {
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );

    act(() => {
      capturedCallbacks.onError?.(new Error("Failed to fetch"));
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toMatch(/Network error/);
  });

  test("in dev, surfaces the actual error message via onError", async () => {
    // Vitest sets import.meta.env.DEV = true by default, mirroring Vite dev.
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );

    act(() => {
      capturedCallbacks.onError?.(
        new Error(
          "[TABLE_OR_VIEW_NOT_FOUND] appkit_demo.public.revenue_metrics",
        ),
      );
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe(
      "[TABLE_OR_VIEW_NOT_FOUND] appkit_demo.public.revenue_metrics",
    );
  });

  test("in prod, falls back to the generic message via onError", async () => {
    vi.stubEnv("DEV", "");
    try {
      const { result } = renderHook(() =>
        useMetricView("revenue", { measures: ["arr"] }),
      );

      act(() => {
        capturedCallbacks.onError?.(
          new Error("[TABLE_OR_VIEW_NOT_FOUND] schema.foo.bar"),
        );
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(result.current.error).toBe(
        "Unable to load data, please try again",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("does NOT auto-start when autoStart=false", () => {
    renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }, { autoStart: false }),
    );
    expect(mockConnectSSE).not.toHaveBeenCalled();
  });

  test("aborts the in-flight request on unmount", () => {
    const { unmount } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }),
    );

    expect(capturedCallbacks.signal?.aborted).toBe(false);
    unmount();
    expect(capturedCallbacks.signal?.aborted).toBe(true);
  });

  test("rejects an empty metric key", () => {
    expect(() =>
      // Cast to any so the runtime guard ("non-empty string") is what fails,
      // not the compile-time MetricKey union (which is augmented in the
      // sibling type-tests file).
      renderHook(() => useMetricView("" as any, { measures: ["arr"] } as any)),
    ).toThrowError(/non-empty string/);
  });

  test("rejects ARROW format with a clear error (out of v1 scope)", async () => {
    const { result } = renderHook(() =>
      useMetricView("revenue", { measures: ["arr"] }, {
        format: "ARROW",
      } as any),
    );

    act(() => {
      capturedCallbacks.onMessage?.({
        data: JSON.stringify({
          type: "arrow",
          statement_id: "s-1",
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toMatch(/ARROW format is not supported/);
  });
});
