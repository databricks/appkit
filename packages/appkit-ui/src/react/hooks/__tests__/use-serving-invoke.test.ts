import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockUsePluginClientConfig = vi
  .fn()
  .mockReturnValue({ isNamedMode: false, aliases: ["default"] });

vi.mock("../use-plugin-config", () => ({
  usePluginClientConfig: (...args: unknown[]) =>
    mockUsePluginClientConfig(...args),
}));

import { useServingInvoke } from "../use-serving-invoke";

describe("useServingInvoke", () => {
  beforeEach(() => {
    mockUsePluginClientConfig.mockReturnValue({
      isNamedMode: false,
      aliases: ["default"],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("initial state is idle", () => {
    const { result } = renderHook(() => useServingInvoke({ messages: [] }));

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.invoke).toBe("function");
  });

  test("calls fetch to correct URL on invoke", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() =>
      useServingInvoke({ messages: [{ role: "user", content: "Hello" }] }),
    );

    act(() => {
      result.current.invoke();
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/serving/invoke",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            messages: [{ role: "user", content: "Hello" }],
          }),
        }),
      );
    });
  });

  test("uses alias in URL when provided", async () => {
    mockUsePluginClientConfig.mockReturnValue({
      isNamedMode: true,
      aliases: ["llm", "embedder"],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() =>
      useServingInvoke({ messages: [] }, { alias: "llm" }),
    );

    act(() => {
      result.current.invoke();
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/serving/llm/invoke",
        expect.any(Object),
      );
    });
  });

  test("sets error for unknown alias", () => {
    mockUsePluginClientConfig.mockReturnValue({
      isNamedMode: true,
      aliases: ["llm", "embedder"],
    });

    const { result } = renderHook(() =>
      useServingInvoke({ messages: [] }, { alias: "unknown" as any }),
    );

    expect(result.current.error).toBe(
      'Unknown serving alias "unknown". Available: llm, embedder',
    );
  });

  test("invoke returns null for unknown alias without calling fetch", async () => {
    mockUsePluginClientConfig.mockReturnValue({
      isNamedMode: true,
      aliases: ["llm"],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() =>
      useServingInvoke({ messages: [] }, { alias: "bad" as any }),
    );

    let returnValue: unknown;
    act(() => {
      returnValue = result.current.invoke();
    });

    expect(await returnValue).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("sets data on successful response", async () => {
    const responseData = {
      choices: [{ message: { content: "Hi" } }],
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(responseData), { status: 200 }),
    );

    const { result } = renderHook(() => useServingInvoke({ messages: [] }));

    act(() => {
      result.current.invoke();
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(responseData);
      expect(result.current.loading).toBe(false);
    });
  });

  test("sets error on failed response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );

    const { result } = renderHook(() => useServingInvoke({ messages: [] }));

    await act(async () => {
      result.current.invoke();
      // Wait for the fetch promise chain to resolve
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Not found");
      expect(result.current.loading).toBe(false);
    });
  });

  test("sets error with HTTP status on non-JSON error response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>Not Found</html>", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const { result } = renderHook(() => useServingInvoke({ messages: [] }));

    await act(async () => {
      result.current.invoke();
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => {
      expect(result.current.error).toBe("HTTP 404");
      expect(result.current.loading).toBe(false);
    });
  });

  test("sets error on fetch network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network timeout"),
    );

    const { result } = renderHook(() => useServingInvoke({ messages: [] }));

    await act(async () => {
      result.current.invoke();
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Network timeout");
      expect(result.current.loading).toBe(false);
    });
  });

  test("auto starts when autoStart is true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderHook(() => useServingInvoke({ messages: [] }, { autoStart: true }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
  });
});
