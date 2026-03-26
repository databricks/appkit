import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// Mock connectSSE
const mockConnectSSE = vi.fn().mockResolvedValue(undefined);

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

import { useServingStream } from "../use-serving-stream";

describe("useServingStream", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("initial state is idle", () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    expect(result.current.chunks).toEqual([]);
    expect(result.current.streaming).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.stream).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });

  test("calls connectSSE with correct URL on stream", () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    result.current.stream();

    expect(mockConnectSSE).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/api/serving/stream",
        payload: JSON.stringify({ messages: [] }),
      }),
    );
  });

  test("uses alias in URL when provided", () => {
    const { result } = renderHook(() =>
      useServingStream({ messages: [] }, { alias: "embedder" }),
    );

    result.current.stream();

    expect(mockConnectSSE).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/api/serving/embedder/stream",
      }),
    );
  });
});
