import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// Mock connectSSE so the hook does not attempt a real network request.
const mockConnectSSE = vi.fn().mockImplementation((_opts: unknown) => {
  // Return a never-resolving promise; tests don't need the result.
  return new Promise<void>(() => {});
});

vi.mock("@/js", () => ({
  ArrowClient: {
    fetchArrow: vi.fn(),
    processArrowBuffer: vi.fn(),
  },
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

// Stub useQueryHMR so we don't pull in import.meta.hot wiring.
vi.mock("../use-query-hmr", () => ({
  useQueryHMR: () => {},
}));

import { useAnalyticsQuery } from "../use-analytics-query";

describe("useAnalyticsQuery", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("does not refetch when params object is structurally equal across renders", () => {
    // Each render passes a fresh object literal — the common footgun.
    const { rerender } = renderHook(
      ({ limit }: { limit: number }) =>
        // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
        useAnalyticsQuery("test_query" as any, { limit } as any),
      { initialProps: { limit: 10 } },
    );

    // Initial render triggers exactly one connection.
    expect(mockConnectSSE).toHaveBeenCalledTimes(1);

    // Re-render with structurally-equal-but-new-reference params.
    rerender({ limit: 10 });
    rerender({ limit: 10 });
    rerender({ limit: 10 });

    // Should NOT have refetched — the hook stabilized the params reference.
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
      // Capture the connectSSE options so we can drive onMessage manually.
      let capturedOnMessage:
        | ((msg: { id: string; data: string }) => void)
        | null = null;
      mockConnectSSE.mockImplementationOnce((opts: any) => {
        capturedOnMessage = opts.onMessage;
        return new Promise<void>(() => {});
      });

      const { result } = renderHook(() =>
        // biome-ignore lint/suspicious/noExplicitAny: typed registry not available in tests
        useAnalyticsQuery("test_query" as any),
      );

      // Initially: loading, no status, no data.
      expect(result.current.loading).toBe(true);
      expect(result.current.warehouseStatus).toBeNull();
      expect(result.current.data).toBeNull();
      expect(capturedOnMessage).toBeTruthy();

      // Server emits a STARTING status — UI should show progress, still loading.
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

      // Then RUNNING.
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

      // Finally the SQL result lands.
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
      // warehouseStatus is left at its last observed value (RUNNING) so
      // consumers that gated on `state !== "RUNNING"` flip back to data.
      expect(result.current.warehouseStatus?.state).toBe("RUNNING");
    });

    test("surfaces an error when a warehouse_status event has no status payload", async () => {
      // A malformed frame must terminate the stream so the hook doesn't
      // stay stuck in `loading: true` after a clean stream close.
      let capturedOnMessage:
        | ((msg: { id: string; data: string }) => void)
        | null = null;
      mockConnectSSE.mockImplementationOnce((opts: any) => {
        capturedOnMessage = opts.onMessage;
        return new Promise<void>(() => {});
      });

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
});
