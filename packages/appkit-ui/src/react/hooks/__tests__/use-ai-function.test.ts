import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockUsePluginClientConfig = vi.fn();

vi.mock("../use-plugin-config", () => ({
  usePluginClientConfig: (...args: unknown[]) =>
    mockUsePluginClientConfig(...args),
}));

import { useAiFunction } from "../use-ai-function";

const OK = { response: [{ value: "billing" }], metadata: { version: "2.1" } };

describe("useAiFunction", () => {
  beforeEach(() => {
    mockUsePluginClientConfig.mockReturnValue({
      tasks: {
        routeTicket: { function: "classify" },
        "my-task": { function: "classify" },
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(OK), { status: 200 }),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  test("posts the input to the task route and stores data", async () => {
    const { result } = renderHook(() => useAiFunction("routeTicket"));
    let returned: unknown;
    await act(async () => {
      returned = await result.current.invoke({ content: "refund" });
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai-functions/routeTicket/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "refund" }),
      }),
    );
    expect(returned).toEqual(OK);
    expect(result.current.data).toEqual(OK);
    expect(result.current.loading).toBe(false);
    expect(mockUsePluginClientConfig).toHaveBeenCalledWith("aiFunctions");
  });

  test("encodes the task name", async () => {
    mockUsePluginClientConfig.mockReturnValue({
      tasks: { "a/b": { function: "classify" } },
    });
    const { result } = renderHook(() => useAiFunction("a/b"));
    await act(async () => {
      await result.current.invoke({ content: "x" });
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai-functions/a%2Fb/invoke",
      expect.anything(),
    );
  });

  test("resets data on each invoke", async () => {
    const { result } = renderHook(() => useAiFunction("routeTicket"));
    await act(async () => {
      await result.current.invoke({ content: "one" });
    });
    let resolveSecond: (r: Response) => void = () => {};
    vi.mocked(globalThis.fetch).mockReturnValueOnce(
      new Promise((r) => (resolveSecond = r)),
    );
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.invoke({ content: "two" });
    });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      resolveSecond(new Response(JSON.stringify(OK), { status: 200 }));
      await pending;
    });
  });

  test("aborts the in-flight call when the task changes", async () => {
    vi.mocked(globalThis.fetch).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const { result, rerender } = renderHook(({ task }) => useAiFunction(task), {
      initialProps: { task: "routeTicket" },
    });
    act(() => {
      void result.current.invoke({ content: "x" });
    });
    const signal = (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit)
      .signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(result.current.loading).toBe(true);
    rerender({ task: "my-task" });
    expect(signal.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  test("an invoke on a now-unknown task aborts the earlier call", async () => {
    let resolveFirst: (r: Response) => void = () => {};
    vi.mocked(globalThis.fetch).mockReturnValueOnce(
      new Promise((r) => (resolveFirst = r)),
    );
    const { result, rerender } = renderHook(() => useAiFunction("routeTicket"));
    act(() => {
      void result.current.invoke({ content: "x" });
    });
    const signal = (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit)
      .signal as AbortSignal;

    // The config no longer lists the task, so the next invoke is rejected.
    mockUsePluginClientConfig.mockReturnValue({
      tasks: { other: { function: "classify" } },
    });
    rerender();
    let returned: unknown = "unset";
    await act(async () => {
      returned = await result.current.invoke({ content: "y" });
    });
    expect(returned).toBeNull();
    expect(signal.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toMatch(
      /No task configured with name "routeTicket"/,
    );

    // The earlier call finishing late doesn't overwrite the error.
    await act(async () => {
      resolveFirst(new Response(JSON.stringify(OK), { status: 200 }));
    });
    expect(result.current.data).toBeNull();
    expect(result.current.error).toMatch(/No task configured/);
  });

  test("clears the previous task's data when the task changes", async () => {
    const { result, rerender } = renderHook(({ task }) => useAiFunction(task), {
      initialProps: { task: "routeTicket" },
    });
    await act(async () => {
      await result.current.invoke({ content: "x" });
    });
    expect(result.current.data).toEqual(OK);
    rerender({ task: "my-task" });
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test("surfaces the error body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "content must not be empty",
          plugin: "aiFunctions",
        }),
        { status: 400 },
      ),
    );
    const { result } = renderHook(() => useAiFunction("routeTicket"));
    await act(async () => {
      expect(await result.current.invoke({ content: " " })).toBeNull();
    });
    expect(result.current.error).toBe("content must not be empty");
  });

  test("falls back to HTTP status when the error body isn't JSON", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("oops", { status: 502 }),
    );
    const { result } = renderHook(() => useAiFunction("routeTicket"));
    await act(async () => {
      await result.current.invoke({ content: "x" });
    });
    expect(result.current.error).toBe("HTTP 502");
  });

  test("blocks unknown tasks without a request", async () => {
    const { result } = renderHook(() => useAiFunction("nope"));
    await act(async () => {
      expect(await result.current.invoke({ content: "x" })).toBeNull();
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.current.error).toBe(
      'No task configured with name "nope". Available: routeTicket, my-task',
    );
  });

  test("an aborted call resolves null and leaves state alone", async () => {
    let rejectFirst: (e: unknown) => void = () => {};
    vi.mocked(globalThis.fetch)
      .mockImplementationOnce(
        () => new Promise((_r, reject) => (rejectFirst = reject)),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(OK), { status: 200 }));
    const { result } = renderHook(() => useAiFunction("routeTicket"));
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.invoke({ content: "one" });
    });
    await act(async () => {
      await result.current.invoke({ content: "two" });
    });
    await act(async () => {
      rejectFirst(new DOMException("aborted", "AbortError"));
      expect(await first).toBeNull();
    });
    expect(result.current.data).toEqual(OK);
    expect(result.current.error).toBeNull();
  });

  test("sends the request when client config isn't loaded", async () => {
    mockUsePluginClientConfig.mockReturnValue({});
    const { result } = renderHook(() => useAiFunction("anything"));
    await act(async () => {
      await result.current.invoke({ content: "x" });
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai-functions/anything/invoke",
      expect.anything(),
    );
  });

  test("aborts the in-flight call on re-invoke and on unmount", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      signals.push((init as RequestInit).signal as AbortSignal);
      return new Promise(() => {});
    });
    const { result, unmount } = renderHook(() => useAiFunction("routeTicket"));
    act(() => {
      void result.current.invoke({ content: "one" });
    });
    act(() => {
      void result.current.invoke({ content: "two" });
    });
    expect(signals[0].aborted).toBe(true);
    unmount();
    expect(signals[1].aborted).toBe(true);
  });
});
