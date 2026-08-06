import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockUsePluginClientConfig = vi.fn();

vi.mock("../use-plugin-config", () => ({
  usePluginClientConfig: (...args: unknown[]) =>
    mockUsePluginClientConfig(...args),
}));

import { useAiSearchQuery } from "../use-ai-search-query";

const RESPONSE = {
  results: [{ score: 0.9, data: { id: "1", text: "hi" } }],
  totalCount: 1,
  queryTimeMs: 12,
  queryType: "hybrid",
  nextPageToken: null,
};

describe("useAiSearchQuery", () => {
  beforeEach(() => {
    mockUsePluginClientConfig.mockReturnValue({
      indexes: [{ alias: "demo", queryType: "hybrid", pagination: false }],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(RESPONSE), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("defaults to the first configured index", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useAiSearchQuery());

    expect(result.current.alias).toBe("demo");
    expect(result.current.error).toBeNull();

    act(() => {
      void result.current.search("hello");
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/ai-search/demo/query",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ queryText: "hello" }),
        }),
      );
    });
  });

  test("uses the provided alias", async () => {
    mockUsePluginClientConfig.mockReturnValue({
      indexes: [
        { alias: "demo", queryType: "hybrid", pagination: false },
        { alias: "docs", queryType: "ann", pagination: false },
      ],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() => useAiSearchQuery({ alias: "docs" }));

    act(() => {
      void result.current.search("hello");
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/ai-search/docs/query",
        expect.any(Object),
      );
    });
  });

  test("forwards a full request object", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useAiSearchQuery());

    act(() => {
      void result.current.search({ queryText: "hi", numResults: 5 });
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/ai-search/demo/query",
        expect.objectContaining({
          body: JSON.stringify({ queryText: "hi", numResults: 5 }),
        }),
      );
    });
  });

  test("errors when no indexes are configured", () => {
    mockUsePluginClientConfig.mockReturnValue({ indexes: [] });

    const { result } = renderHook(() => useAiSearchQuery());

    expect(result.current.alias).toBeNull();
    expect(result.current.error).toBe("No AI Search indexes are configured.");
  });

  test("errors for an unknown alias without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() => useAiSearchQuery({ alias: "nope" }));

    expect(result.current.error).toBe(
      'Unknown AI Search index "nope". Available: demo',
    );

    let returnValue: unknown;
    act(() => {
      returnValue = result.current.search("hello");
    });

    expect(await returnValue).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("sets data on a successful search", async () => {
    const { result } = renderHook(() => useAiSearchQuery());

    act(() => {
      void result.current.search("hello");
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(RESPONSE);
      expect(result.current.loading).toBe(false);
    });
  });

  test("surfaces the server error message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "index not ready" }), {
        status: 500,
      }),
    );

    const { result } = renderHook(() => useAiSearchQuery());

    await act(async () => {
      void result.current.search("hello");
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => {
      expect(result.current.error).toBe("index not ready");
      expect(result.current.loading).toBe(false);
    });
  });

  test("clears stale data when the alias changes", async () => {
    mockUsePluginClientConfig.mockReturnValue({
      indexes: [
        { alias: "demo", queryType: "hybrid", pagination: false },
        { alias: "docs", queryType: "ann", pagination: false },
      ],
    });

    const { result, rerender } = renderHook(
      ({ alias }) => useAiSearchQuery({ alias }),
      { initialProps: { alias: "demo" } },
    );

    act(() => {
      void result.current.search("hello");
    });
    await waitFor(() => expect(result.current.data).toEqual(RESPONSE));

    // Switch index: prior results must not linger under the new alias.
    rerender({ alias: "docs" });
    expect(result.current.alias).toBe("docs");
    expect(result.current.data).toBeNull();
  });

  test("re-syncs the error when the alias becomes unknown", async () => {
    mockUsePluginClientConfig.mockReturnValue({
      indexes: [{ alias: "demo", queryType: "hybrid", pagination: false }],
    });

    const { result, rerender } = renderHook(
      ({ alias }) => useAiSearchQuery({ alias }),
      { initialProps: { alias: "demo" } },
    );

    expect(result.current.error).toBeNull();

    rerender({ alias: "nope" });
    expect(result.current.error).toBe(
      'Unknown AI Search index "nope". Available: demo',
    );
  });
});
