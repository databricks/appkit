import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

let lastConnectArgs: any = null;
let capturedCallbacks: {
  onMessage?: (msg: { data: string }) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
} = {};

const mockFetchArrow = vi.fn();
const mockProcessArrowBuffer = vi.fn();

// Mock connectSSE so the hook does not attempt a real network request.
// Capture both the full args (used by the arrow/result/error tests) and the
// individual callbacks/signal (used by the warehouse-status and late-envelope
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
  ArrowClient: {
    fetchArrow: (...args: unknown[]) => mockFetchArrow(...args),
    processArrowBuffer: (...args: unknown[]) => mockProcessArrowBuffer(...args),
  },
}));

vi.mock("../use-query-hmr", () => ({
  useQueryHMR: vi.fn(),
}));

import { useAnalyticsQuery } from "../use-analytics-query";

function markAborted() {
  const sig = capturedCallbacks.signal;
  if (!sig) throw new Error("signal not captured yet");
  Object.defineProperty(sig, "aborted", { value: true, configurable: true });
}

describe("useAnalyticsQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastConnectArgs = null;
    capturedCallbacks = {};
  });

  test("fetches an arrow message (warehouse statement id) via /arrow-result", async () => {
    const fakeTable = { numRows: 1, schema: { fields: [] } };
    const fakeBytes = new Uint8Array([1, 2, 3]);
    mockFetchArrow.mockResolvedValueOnce(fakeBytes);
    mockProcessArrowBuffer.mockResolvedValueOnce(fakeTable);

    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
    );

    await lastConnectArgs.onMessage({
      data: JSON.stringify({ type: "arrow", statement_id: "stmt-warehouse-1" }),
    });

    await waitFor(() => {
      expect(result.current.data).toBe(fakeTable);
    });

    expect(mockFetchArrow).toHaveBeenCalledTimes(1);
    expect(mockFetchArrow).toHaveBeenCalledWith(
      "/api/analytics/arrow-result/stmt-warehouse-1",
    );
    expect(mockProcessArrowBuffer).toHaveBeenCalledWith(fakeBytes);
  });

  test("fetches an arrow message with synthetic inline- id through the same /arrow-result path", async () => {
    // The client must treat inline and external-links responses uniformly —
    // it never decodes base64 locally. The /arrow-result route on the
    // server is the only place that knows which path the bytes came from.
    const fakeTable = { numRows: 1, schema: { fields: [] } };
    const fakeBytes = new Uint8Array([1, 2, 3, 4, 5]);
    mockFetchArrow.mockResolvedValueOnce(fakeBytes);
    mockProcessArrowBuffer.mockResolvedValueOnce(fakeTable);

    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
    );

    await lastConnectArgs.onMessage({
      data: JSON.stringify({
        type: "arrow",
        statement_id: "inline-abc-xyz",
      }),
    });

    await waitFor(() => {
      expect(result.current.data).toBe(fakeTable);
    });

    expect(mockFetchArrow).toHaveBeenCalledTimes(1);
    expect(mockFetchArrow).toHaveBeenCalledWith(
      "/api/analytics/arrow-result/inline-abc-xyz",
    );
  });

  test("surfaces an error when the arrow fetch fails", async () => {
    mockFetchArrow.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
    );

    await lastConnectArgs.onMessage({
      data: JSON.stringify({ type: "arrow", statement_id: "stmt-1" }),
    });

    await waitFor(() => {
      expect(result.current.error).toBe(
        "Unable to load data, please try again",
      );
    });
    expect(result.current.loading).toBe(false);
  });

  test("rejects the retired arrow_inline message type as schema-invalid", async () => {
    // arrow_inline was the prior wire shape. The discriminated union no
    // longer accepts it, so it falls through to the generic error/code
    // branch — but critically, it must NEVER trigger ArrowClient calls.
    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
    );

    await lastConnectArgs.onMessage({
      data: JSON.stringify({ type: "arrow_inline", attachment: "AQID" }),
    });

    await waitFor(() => {
      expect(
        result.current.loading ||
          result.current.error ||
          result.current.data === null,
      ).toBeTruthy();
    });
    expect(mockProcessArrowBuffer).not.toHaveBeenCalled();
    expect(mockFetchArrow).not.toHaveBeenCalled();
  });

  test("normalizes an empty result message (no data field) to []", async () => {
    // The wire schema makes `data` optional — empty result sets may omit
    // it. The hook must surface that as an explicit empty array rather
    // than `undefined`, so callers can rely on `data` being either null
    // (no message yet) or a value of the inferred result type.
    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "JSON_ARRAY" }),
    );

    await lastConnectArgs.onMessage({
      data: JSON.stringify({ type: "result" }),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("still handles type:result rows for JSON_ARRAY", async () => {
    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "JSON_ARRAY" }),
    );

    await lastConnectArgs.onMessage({
      data: JSON.stringify({
        type: "result",
        data: [{ id: 1 }, { id: 2 }],
      }),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([{ id: 1 }, { id: 2 }]);
    });
    expect(mockProcessArrowBuffer).not.toHaveBeenCalled();
    expect(mockFetchArrow).not.toHaveBeenCalled();
  });

  test("a malformed (non-JSON) SSE payload clears loading and surfaces an error — does not strand the hook in loading=true", async () => {
    // A `JSON.parse` failure inside the SSE handler used to be swallowed
    // by the outer catch with only a console.warn, leaving the hook
    // permanently in `loading=true` with no error surfaced. The UI would
    // spin forever. The handler now reports a user-facing error so the
    // consumer can render a retry affordance.
    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "JSON_ARRAY" }),
    );

    await lastConnectArgs.onMessage({ data: "not-json{" });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe("Unable to load data, please try again");
    expect(result.current.data).toBeNull();
  });

  test("a server error event carrying a structured errorCode exposes it on the hook return value", async () => {
    // The SSE error broadcaster forwards an `errorCode` field for
    // UI branching (e.g. INLINE_ARROW_STASH_EXHAUSTED). The hook
    // surfaces both the human `error` text AND the structured
    // `errorCode` so consumers can branch on the stable identifier
    // instead of substring-matching the sanitized human message.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
    );

    await lastConnectArgs.onMessage({
      data: JSON.stringify({
        type: "error",
        error: "Server is at capacity, please retry",
        code: "UPSTREAM_ERROR",
        errorCode: "INLINE_ARROW_STASH_EXHAUSTED",
      }),
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Server is at capacity, please retry");
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.errorCode).toBe("INLINE_ARROW_STASH_EXHAUSTED");

    errorSpy.mockRestore();
  });

  test("does not refetch when params object is structurally equal across renders", () => {
    const { rerender } = renderHook(
      ({ limit }: { limit: number }) =>
        // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
        useAnalyticsQuery("test_query" as any, { limit } as any),
      { initialProps: { limit: 10 } },
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    rerender({ limit: 10 });
    rerender({ limit: 10 });
    rerender({ limit: 10 });

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
  });

  test("does refetch when a param value actually changes", () => {
    const { rerender } = renderHook(
      ({ limit }: { limit: number }) =>
        // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
        useAnalyticsQuery("test_query" as any, { limit } as any),
      { initialProps: { limit: 10 } },
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    rerender({ limit: 20 });

    expect(mockConnectSSE).toHaveBeenCalledTimes(2);
  });

  test("does not refetch when params is undefined across renders", () => {
    const { rerender } = renderHook(() =>
      // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
      useAnalyticsQuery("test_query" as any),
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    rerender();
    rerender();

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
  });

  test("treats two empty object literals as equal", () => {
    const { rerender } = renderHook(() =>
      // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
      useAnalyticsQuery("test_query" as any, {} as any),
    );

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    rerender();
    rerender();

    expect(mockConnectSSE).toHaveBeenCalledTimes(1);
  });

  describe("warehouse_status", () => {
    test("surfaces warehouseStatus while waiting and clears loading on result", async () => {
      let capturedOnMessage:
        | ((msg: { id: string; data: string }) => void)
        | null = null;
      mockConnectSSE.mockImplementationOnce(
        (opts: { onMessage?: (msg: { id: string; data: string }) => void }) => {
          capturedOnMessage = opts.onMessage ?? null;
          return new Promise<void>(() => {});
        },
      );

      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
        useAnalyticsQuery("test_query" as any),
      );

      expect(result.current.loading).toBe(true);
      expect(result.current.warehouseStatus).toBeNull();
      expect(result.current.data).toBeNull();
      expect(capturedOnMessage).toBeTruthy();

      act(() => {
        capturedOnMessage?.({
          id: "1",
          data: JSON.stringify({
            type: "warehouse_status",
            status: { state: "STARTING", elapsedMs: 1200 },
          }),
        });
      });

      await waitFor(() => {
        expect(result.current.warehouseStatus).toEqual({
          state: "STARTING",
          elapsedMs: 1200,
        });
      });
      expect(result.current.loading).toBe(true);
      expect(result.current.data).toBeNull();

      act(() => {
        capturedOnMessage?.({
          id: "2",
          data: JSON.stringify({
            type: "warehouse_status",
            status: { state: "RUNNING", elapsedMs: 4500 },
          }),
        });
      });

      await waitFor(() => {
        expect(result.current.warehouseStatus?.state).toBe("RUNNING");
      });

      act(() => {
        capturedOnMessage?.({
          id: "3",
          data: JSON.stringify({
            type: "result",
            data: [{ id: 1, name: "row1" }],
          }),
        });
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(result.current.data).toEqual([{ id: 1, name: "row1" }]);
      expect(result.current.error).toBeNull();
      expect(result.current.warehouseStatus?.state).toBe("RUNNING");
    });

    test("surfaces an error when a warehouse_status event has no status payload", async () => {
      let capturedOnMessage:
        | ((msg: { id: string; data: string }) => void)
        | null = null;
      mockConnectSSE.mockImplementationOnce(
        (opts: { onMessage?: (msg: { id: string; data: string }) => void }) => {
          capturedOnMessage = opts.onMessage ?? null;
          return new Promise<void>(() => {});
        },
      );

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
        useAnalyticsQuery("test_query" as any),
      );

      act(() => {
        capturedOnMessage?.({
          id: "1",
          data: JSON.stringify({ type: "warehouse_status" }),
        });
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toMatch(/Unable to load data/);
      expect(result.current.warehouseStatus).toBeNull();

      consoleError.mockRestore();
    });
  });

  describe("aborted controller", () => {
    test("ignores late error envelope after the controller was aborted", async () => {
      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
        useAnalyticsQuery("test_query" as any),
      );

      await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());

      markAborted();

      await act(async () => {
        await capturedCallbacks.onMessage?.({
          data: JSON.stringify({
            type: "error",
            error: "Statement failed: The operation was aborted.",
            code: "UPSTREAM_ERROR",
          }),
        });
      });

      expect(result.current.error).toBeNull();
    });

    test("ignores late result envelope after the controller was aborted", async () => {
      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
        useAnalyticsQuery("test_query" as any),
      );

      await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());

      markAborted();

      await act(async () => {
        await capturedCallbacks.onMessage?.({
          data: JSON.stringify({ type: "result", data: [{ id: 99 }] }),
        });
      });

      expect(result.current.data).toBeNull();
    });

    test("ignores late arrow envelope after the controller was aborted", async () => {
      const { result } = renderHook(() =>
        useAnalyticsQuery("test_query", null, { format: "ARROW_STREAM" }),
      );

      await waitFor(() => expect(capturedCallbacks.signal).toBeDefined());

      markAborted();

      await act(async () => {
        await capturedCallbacks.onMessage?.({
          data: JSON.stringify({ type: "arrow", statement_id: "stmt-123" }),
        });
      });

      expect(mockFetchArrow).not.toHaveBeenCalled();
      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });
});
