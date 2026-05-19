import { renderHook } from "@testing-library/react";
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
});
