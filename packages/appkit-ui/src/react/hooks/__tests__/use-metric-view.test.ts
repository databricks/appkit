import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

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
      renderHook(() => useMetricView("", { measures: ["arr"] } as any)),
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
