import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

// Keep the actual parser/reader; only the HTTP response is controlled.
vi.mock("@/js", async () => ({
  connectSSE: (await import("../../../js/sse/connect-sse")).connectSSE,
  ArrowClient: {},
}));
vi.mock("../use-query-hmr", () => ({ useQueryHMR: vi.fn() }));

import { resetAnalyticsRequestStore } from "../analytics-request-store";
import { useAnalyticsQuery } from "../use-analytics-query";
import { useMetricView } from "../use-metric-view";

afterEach(() => {
  cleanup();
  resetAnalyticsRequestStore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test.each(["query", "metric"])(
  "a stalled body hits the client deadline without retrying the mounted %s hook",
  async (kind) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(controller) {
              options.signal.addEventListener("abort", () =>
                controller.error(options.signal.reason),
              );
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const useRequest =
      kind === "query"
        ? () => useAnalyticsQuery("stalled", null, { format: "JSON_ARRAY" })
        : () => useMetricView("stalled", { measures: ["value"] });
    const { result } = renderHook(useRequest);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300001);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("Request timed out, please try again");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

test.each(["query", "metric"])(
  "EOF following only warehouse status settles the mounted %s hook",
  async (kind) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            'data: {"type":"warehouse_status","status":{"state":"RUNNING"}}\n\n',
          ),
        ),
    );
    const useRequest =
      kind === "query"
        ? () => useAnalyticsQuery("eof", null, { format: "JSON_ARRAY" })
        : () => useMetricView("eof", { measures: ["value"] });
    const { result } = renderHook(useRequest);
    await waitFor(() => expect(result.current.error).toContain("interrupted"));
    expect(result.current.loading).toBe(false);
  },
);

test.each([
  ['{"type":"result","data":[{"value":1}]}', null],
  [
    '{"error":"Query timed out, please try again","code":"TIMEOUT","errorCode":"TIMEOUT"}',
    "Query timed out, please try again",
  ],
])(
  "a terminal payload settles once even with trailing frames: %s",
  async (payload, error) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `data: ${payload}\n\ndata: {"error":"late error","code":"INTERNAL_ERROR"}\n\n`,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useAnalyticsQuery("terminal", null, { format: "JSON_ARRAY" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(error);
    if (error === null) expect(result.current.data).toEqual([{ value: 1 }]);
    else expect(result.current.errorCode).toBe("TIMEOUT");
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

test("a late stream failure cannot overwrite an already received result", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  const { result } = renderHook(() =>
    useAnalyticsQuery("late", null, { format: "JSON_ARRAY" }),
  );
  await act(async () => {
    stream.enqueue(
      new TextEncoder().encode('data: {"type":"result","data":[]}\n\n'),
    );
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    stream.error(new Error("late transport failure"));
  });
  expect(result.current.error).toBe(null);
  expect(result.current.data).toEqual([]);
});
