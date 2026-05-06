import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// Mock connectSSE — capture callbacks so we can simulate SSE events
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

const mockFetchArrow = vi.fn();
const mockProcessArrowBuffer = vi.fn();

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
  ArrowClient: {
    fetchArrow: (...args: unknown[]) => mockFetchArrow(...args),
    processArrowBuffer: (...args: unknown[]) => mockProcessArrowBuffer(...args),
  },
}));

import { useAnalyticsQuery } from "../use-analytics-query";

/** Force `signal.aborted` to true on the captured signal — simulates the
 * cleanup phase of the first StrictMode mount. */
function markAborted() {
  const sig = capturedCallbacks.signal;
  if (!sig) throw new Error("signal not captured yet");
  Object.defineProperty(sig, "aborted", { value: true, configurable: true });
}

describe("useAnalyticsQuery", () => {
  afterEach(() => {
    capturedCallbacks = {};
    vi.clearAllMocks();
  });

  test("initial state is idle", () => {
    const { result } = renderHook(() =>
      useAnalyticsQuery("revenue", null, { autoStart: false }),
    );

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("autoStart calls connectSSE with the query URL on mount", async () => {
    renderHook(() => useAnalyticsQuery("revenue", { region: "us" }));

    await waitFor(() => {
      expect(mockConnectSSE).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/api/analytics/query/revenue",
          payload: JSON.stringify({
            parameters: { region: "us" },
            format: "JSON",
          }),
        }),
      );
    });
  });

  test("normal `result` envelope sets data on the happy path", async () => {
    const { result } = renderHook(() => useAnalyticsQuery("revenue", null));

    await waitFor(() => expect(capturedCallbacks.onMessage).toBeDefined());

    await act(async () => {
      await capturedCallbacks.onMessage?.({
        data: JSON.stringify({ type: "result", data: [{ id: 1 }] }),
      });
    });

    expect(result.current.data).toEqual([{ id: 1 }]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  test("normal `error` envelope sets error on the unhappy path", async () => {
    const { result } = renderHook(() => useAnalyticsQuery("revenue", null));

    await waitFor(() => expect(capturedCallbacks.onMessage).toBeDefined());

    await act(async () => {
      await capturedCallbacks.onMessage?.({
        data: JSON.stringify({
          type: "error",
          error: "Statement failed",
          code: "EXECUTION_ERROR",
        }),
      });
    });

    expect(result.current.error).toBe("Statement failed");
    expect(result.current.loading).toBe(false);
  });

  test("ignores late `error` envelope arriving after the controller was aborted", async () => {
    // Regression: under React StrictMode the first mount's cleanup aborts
    // the controller it owns, but the server-side SSE writer can still
    // emit a final `event: error` envelope on the already-open stream
    // (cancellation hand-off). Without an early `aborted` guard in
    // onMessage, that envelope hit the error branch and surfaced a
    // transient user-visible error before the second mount's data arrived.
    // The fix mirrors the guard already present at the top of `onError`.
    const { result } = renderHook(() => useAnalyticsQuery("revenue", null));

    await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());

    markAborted();

    await act(async () => {
      await capturedCallbacks.onMessage?.({
        data: JSON.stringify({
          type: "error",
          error: "Statement was canceled",
          code: "STREAM_ABORTED",
        }),
      });
    });

    expect(result.current.error).toBeNull();
  });

  test("ignores late `result` envelope arriving after the controller was aborted", async () => {
    const { result } = renderHook(() => useAnalyticsQuery("revenue", null));

    await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());

    markAborted();

    await act(async () => {
      await capturedCallbacks.onMessage?.({
        data: JSON.stringify({ type: "result", data: [{ id: 99 }] }),
      });
    });

    expect(result.current.data).toBeNull();
  });

  test("ignores late `arrow` envelope arriving after the controller was aborted", async () => {
    const { result } = renderHook(() =>
      useAnalyticsQuery("revenue", null, { format: "ARROW" }),
    );

    await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());

    markAborted();

    await act(async () => {
      await capturedCallbacks.onMessage?.({
        data: JSON.stringify({ type: "arrow", statement_id: "stmt-123" }),
      });
    });

    // Critical: an aborted controller must NOT trigger the side-effectful
    // arrow fetch — that would hit the network for a result the consumer
    // has already given up on.
    expect(mockFetchArrow).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test("aborts the controller on unmount", async () => {
    const { unmount } = renderHook(() => useAnalyticsQuery("revenue", null));

    await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());

    expect(capturedCallbacks.signal?.aborted).toBe(false);

    unmount();

    expect(capturedCallbacks.signal?.aborted).toBe(true);
  });
});
