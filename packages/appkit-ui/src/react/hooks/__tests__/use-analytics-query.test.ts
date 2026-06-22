import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

let capturedCallbacks: {
  onMessage?: (msg: { data: string }) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
} = {};

const mockFetchArrow = vi.fn();
const mockProcessArrowBuffer = vi.fn();

// Mock connectSSE so the hook does not attempt a real network request.
const mockConnectSSE = vi
  .fn()
  .mockImplementation(
    (opts: {
      onMessage?: (msg: { data: string }) => void;
      onError?: (err: Error) => void;
      signal?: AbortSignal;
    }) => {
      capturedCallbacks = {
        onMessage: opts.onMessage,
        onError: opts.onError,
        signal: opts.signal,
      };
      return new Promise<void>(() => {});
    },
  );

vi.mock("@/js", () => ({
  ArrowClient: {
    fetchArrow: (...args: unknown[]) => mockFetchArrow(...args),
    processArrowBuffer: (...args: unknown[]) => mockProcessArrowBuffer(...args),
  },
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

// Stub useQueryHMR so we don't pull in import.meta.hot wiring.
vi.mock("../use-query-hmr", () => ({
  useQueryHMR: () => {},
}));

import { useAnalyticsQuery } from "../use-analytics-query";

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
