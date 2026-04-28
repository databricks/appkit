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

  test("decodes arrow_inline base64 attachment via ArrowClient.processArrowBuffer", async () => {
    const fakeTable = { numRows: 1, schema: { fields: [] } };
    mockProcessArrowBuffer.mockResolvedValueOnce(fakeTable);

    // 'AQID' decodes to bytes [1, 2, 3].
    const base64 = "AQID";

    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
    );

    // Drive the SSE onMessage handler with an arrow_inline payload.
    await lastConnectArgs.onMessage({
      data: JSON.stringify({ type: "arrow_inline", attachment: base64 }),
    });

    await waitFor(() => {
      expect(result.current.data).toBe(fakeTable);
    });

    expect(mockProcessArrowBuffer).toHaveBeenCalledTimes(1);
    const passedBuffer = mockProcessArrowBuffer.mock.calls[0][0] as Uint8Array;
    expect(passedBuffer).toBeInstanceOf(Uint8Array);
    expect(Array.from(passedBuffer)).toEqual([1, 2, 3]);
    // Inline path must NOT trigger a network fetch.
    expect(mockFetchArrow).not.toHaveBeenCalled();
  });

  test("surfaces an error when arrow_inline decode fails", async () => {
    mockProcessArrowBuffer.mockRejectedValueOnce(new Error("bad ipc"));

    const { result } = renderHook(() =>
      useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
    );

    await lastConnectArgs.onMessage({
      data: JSON.stringify({ type: "arrow_inline", attachment: "AQID" }),
    });

    await waitFor(() => {
      expect(result.current.error).toBe(
        "Unable to load data, please try again",
      );
    });
    expect(result.current.loading).toBe(false);
  });

  test("rejects arrow_inline with missing/empty/non-string attachment without crashing atob", async () => {
    const cases: Array<unknown> = [undefined, null, "", 123, { foo: "bar" }];

    for (const attachment of cases) {
      mockProcessArrowBuffer.mockClear();
      const { result, unmount } = renderHook(() =>
        useAnalyticsQuery("q", null, { format: "ARROW_STREAM" }),
      );

      await lastConnectArgs.onMessage({
        data: JSON.stringify({ type: "arrow_inline", attachment }),
      });

      await waitFor(() => {
        expect(result.current.error).toBe(
          "Unable to load data, please try again",
        );
      });
      // Critically: must NOT call processArrowBuffer (or atob) on the bad input.
      expect(mockProcessArrowBuffer).not.toHaveBeenCalled();

      unmount();
    }
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
});
