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

    // Whatever the hook surfaces (error or noop), it must not have tried to
    // decode the payload locally.
    await waitFor(() => {
      // Either an error is set or loading completed without data — both are
      // acceptable, but processArrowBuffer must never run on a base64 input.
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
});
