import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// Mock connectSSE — capture callbacks so we can simulate SSE events
let capturedCallbacks: {
  onMessage?: (msg: { data: string }) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
} = {};

let resolveStream: (() => void) | null = null;

const mockConnectSSE = vi.fn().mockImplementation((opts: any) => {
  capturedCallbacks = {
    onMessage: opts.onMessage,
    onError: opts.onError,
    signal: opts.signal,
  };
  return new Promise<void>((resolve) => {
    resolveStream = resolve;
    // Also resolve after a tick as fallback for tests that don't manually resolve
    setTimeout(resolve, 0);
  });
});

const mockUsePluginClientConfig = vi
  .fn()
  .mockReturnValue({ isNamedMode: false, aliases: ["default"] });

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

vi.mock("../use-plugin-config", () => ({
  usePluginClientConfig: (...args: unknown[]) =>
    mockUsePluginClientConfig(...args),
}));

import { useServingStream } from "../use-serving-stream";

describe("useServingStream", () => {
  afterEach(() => {
    capturedCallbacks = {};
    resolveStream = null;
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

    act(() => {
      result.current.stream();
    });

    expect(mockConnectSSE).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/api/serving/stream",
        payload: JSON.stringify({ messages: [] }),
      }),
    );
  });

  test("uses override body when passed to stream()", () => {
    const { result } = renderHook(() =>
      useServingStream({ messages: [{ role: "user", content: "old" }] }),
    );

    const overrideBody = {
      messages: [{ role: "user" as const, content: "new" }],
    };

    act(() => {
      result.current.stream(overrideBody);
    });

    expect(mockConnectSSE).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: JSON.stringify(overrideBody),
      }),
    );
  });

  test("uses alias in URL when provided", () => {
    mockUsePluginClientConfig.mockReturnValue({
      isNamedMode: true,
      aliases: ["embedder", "llm"],
    });
    const { result } = renderHook(() =>
      useServingStream({ messages: [] }, { alias: "embedder" }),
    );

    act(() => {
      result.current.stream();
    });

    expect(mockConnectSSE).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/api/serving/embedder/stream",
      }),
    );
  });

  test("sets error for unknown alias", () => {
    mockUsePluginClientConfig.mockReturnValue({
      isNamedMode: true,
      aliases: ["llm", "embedder"],
    });

    const { result } = renderHook(() =>
      useServingStream({ messages: [] }, { alias: "unknown" as any }),
    );

    expect(result.current.error).toBe(
      'Unknown serving alias "unknown". Available: llm, embedder',
    );
  });

  test("stream does not call connectSSE for unknown alias", () => {
    mockUsePluginClientConfig.mockReturnValue({
      isNamedMode: true,
      aliases: ["llm"],
    });

    const { result } = renderHook(() =>
      useServingStream({ messages: [] }, { alias: "bad" as any }),
    );

    act(() => {
      result.current.stream();
    });

    expect(mockConnectSSE).not.toHaveBeenCalled();
  });

  test("sets streaming to true when stream() is called", () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    act(() => {
      result.current.stream();
    });

    expect(result.current.streaming).toBe(true);
  });

  test("accumulates chunks from onMessage", async () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    act(() => {
      result.current.stream();
    });

    act(() => {
      capturedCallbacks.onMessage?.({ data: JSON.stringify({ id: 1 }) });
    });

    act(() => {
      capturedCallbacks.onMessage?.({ data: JSON.stringify({ id: 2 }) });
    });

    expect(result.current.chunks).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("accumulates chunks with error field as normal data", async () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    act(() => {
      result.current.stream();
    });

    act(() => {
      capturedCallbacks.onMessage?.({
        data: JSON.stringify({ error: "Model overloaded" }),
      });
    });

    // Chunks with an `error` field are treated as data, not stream errors.
    // Transport-level errors are delivered via onError callback instead.
    expect(result.current.chunks).toEqual([{ error: "Model overloaded" }]);
    expect(result.current.error).toBeNull();
    expect(result.current.streaming).toBe(true);
  });

  test("sets error from onError callback", async () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    act(() => {
      result.current.stream();
    });

    act(() => {
      capturedCallbacks.onError?.(new Error("Connection lost"));
    });

    expect(result.current.error).toBe("Connection lost");
    expect(result.current.streaming).toBe(false);
  });

  test("silently skips malformed JSON messages", () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    act(() => {
      result.current.stream();
    });

    act(() => {
      capturedCallbacks.onMessage?.({ data: "not valid json{" });
    });

    // No chunks added, no error set
    expect(result.current.chunks).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  test("reset() clears state and aborts active stream", () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    act(() => {
      result.current.stream();
    });

    act(() => {
      capturedCallbacks.onMessage?.({ data: JSON.stringify({ id: 1 }) });
    });

    expect(result.current.chunks).toHaveLength(1);
    expect(result.current.streaming).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.chunks).toEqual([]);
    expect(result.current.streaming).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("autoStart triggers stream on mount", async () => {
    renderHook(() => useServingStream({ messages: [] }, { autoStart: true }));

    await waitFor(() => {
      expect(mockConnectSSE).toHaveBeenCalled();
    });
  });

  test("passes abort signal to connectSSE", () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    act(() => {
      result.current.stream();
    });

    expect(capturedCallbacks.signal).toBeDefined();
    expect(capturedCallbacks.signal?.aborted).toBe(false);
  });

  test("aborts stream on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useServingStream({ messages: [] }),
    );

    act(() => {
      result.current.stream();
    });

    const signal = capturedCallbacks.signal;
    expect(signal?.aborted).toBe(false);

    unmount();

    expect(signal?.aborted).toBe(true);
  });

  test("sets streaming to false when connectSSE resolves", async () => {
    const { result } = renderHook(() => useServingStream({ messages: [] }));

    act(() => {
      result.current.stream();
    });

    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });
  });

  test("sets error when connectSSE promise rejects", async () => {
    mockConnectSSE.mockImplementationOnce((opts: any) => {
      capturedCallbacks = {
        onMessage: opts.onMessage,
        onError: opts.onError,
        signal: opts.signal,
      };
      return Promise.reject(new Error("Network failure"));
    });

    const { result } = renderHook(() => useServingStream({ messages: [] }));

    act(() => {
      result.current.stream();
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Connection error");
      expect(result.current.streaming).toBe(false);
    });
  });

  test("calls onComplete with accumulated chunks when stream finishes", async () => {
    const onComplete = vi.fn();

    // Use a controllable mock so stream doesn't auto-resolve
    mockConnectSSE.mockImplementationOnce((opts: any) => {
      capturedCallbacks = {
        onMessage: opts.onMessage,
        onError: opts.onError,
        signal: opts.signal,
      };
      return new Promise<void>((resolve) => {
        resolveStream = resolve;
      });
    });

    const { result } = renderHook(() =>
      useServingStream({ messages: [] }, { onComplete }),
    );

    act(() => {
      result.current.stream();
    });

    // Send two chunks
    act(() => {
      capturedCallbacks.onMessage?.({ data: JSON.stringify({ id: 1 }) });
    });
    act(() => {
      capturedCallbacks.onMessage?.({ data: JSON.stringify({ id: 2 }) });
    });

    expect(onComplete).not.toHaveBeenCalled();

    // Complete the stream
    await act(async () => {
      resolveStream?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(onComplete).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }]);
  });
});
