import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Capture the onMessage handler so tests can drive SSE messages directly.
let lastConnectArgs: any = null;
const mockProcessArrowBuffer = vi.fn();
const mockFetchArrow = vi.fn();

vi.mock("@/js", () => ({
  connectSSE: vi.fn((args: any) => {
    lastConnectArgs = args;
    return () => {};
  }),
  ArrowClient: {
    fetchArrow: (...args: unknown[]) => mockFetchArrow(...args),
    processArrowBuffer: (...args: unknown[]) => mockProcessArrowBuffer(...args),
  },
}));

// useQueryHMR is a no-op shim for tests; mock to avoid HMR side effects.
vi.mock("../use-query-hmr", () => ({
  useQueryHMR: vi.fn(),
}));

import { useAnalyticsQuery } from "../use-analytics-query";

describe("useAnalyticsQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastConnectArgs = null;
  });

  test("fetches Arrow IPC via /arrow-result for type:arrow (covers both inline-stash and external-link paths)", async () => {
    const fakeTable = { numRows: 0, schema: { fields: [] } };
    mockFetchArrow.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    mockProcessArrowBuffer.mockResolvedValueOnce(fakeTable);

    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
    );

    // Server emits the same {type:"arrow", statement_id} shape regardless of
    // whether the bytes came from the warehouse (EXTERNAL_LINKS) or were
    // stashed locally (INLINE).
    await lastConnectArgs.onMessage({
      data: JSON.stringify({ type: "arrow", statement_id: "inline-abc" }),
    });

    await waitFor(() => {
      expect(result.current.data).toBe(fakeTable);
    });
    expect(mockFetchArrow).toHaveBeenCalledTimes(1);
    expect(mockFetchArrow.mock.calls[0][0]).toBe(
      "/api/analytics/arrow-result/inline-abc",
    );
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
  });

  test("surfaces an error when /arrow-result fetch fails", async () => {
    mockFetchArrow.mockRejectedValueOnce(new Error("HTTP 404"));

    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
    );

    await lastConnectArgs.onMessage({
      data: JSON.stringify({ type: "arrow", statement_id: "inline-stale" }),
    });

    await waitFor(() => {
      expect(result.current.error).toBe(
        "Unable to load data, please try again",
      );
    });
    expect(result.current.loading).toBe(false);
  });
});
