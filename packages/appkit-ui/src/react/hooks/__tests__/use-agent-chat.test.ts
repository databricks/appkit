import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

let capturedCallbacks: {
  onMessage?: (msg: { data: string }) => Promise<void>;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
  url?: string;
  payload?: unknown;
  maxRetries?: number;
} = {};

let resolveStream: (() => void) | null = null;
let rejectStream: ((err: Error) => void) | null = null;

const mockConnectSSE = vi.fn().mockImplementation((opts: any) => {
  capturedCallbacks = {
    onMessage: opts.onMessage,
    onError: opts.onError,
    signal: opts.signal,
    url: opts.url,
    payload: opts.payload,
    maxRetries: opts.maxRetries,
  };
  return new Promise<void>((resolve, reject) => {
    resolveStream = resolve;
    rejectStream = reject;
  });
});

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

import { useAgentChat } from "../use-agent-chat";

async function emit(data: string) {
  // Allow microtasks to settle before pushing the next message.
  await capturedCallbacks.onMessage?.({ data });
}

describe("useAgentChat", () => {
  afterEach(() => {
    capturedCallbacks = {};
    resolveStream = null;
    rejectStream = null;
    vi.clearAllMocks();
  });

  test("initial state is idle", () => {
    const { result } = renderHook(() => useAgentChat({ agent: "helper" }));

    expect(result.current.content).toBe("");
    expect(result.current.events).toEqual([]);
    expect(result.current.threadId).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.send).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });

  test("send() posts to /api/agents/chat with the agent name and message", async () => {
    const { result } = renderHook(() => useAgentChat({ agent: "helper" }));

    act(() => {
      void result.current.send("hello");
    });

    await waitFor(() => expect(mockConnectSSE).toHaveBeenCalled());

    expect(capturedCallbacks.url).toBe("/api/agents/chat");
    expect(capturedCallbacks.payload).toEqual({
      message: "hello",
      agent: "helper",
    });
    // Chat turns are not safely retryable — assert we explicitly opt out.
    expect(capturedCallbacks.maxRetries).toBe(0);
  });

  test("custom endpoint is forwarded to connectSSE", async () => {
    const { result } = renderHook(() =>
      useAgentChat({ agent: "helper", endpoint: "/v2/chat" }),
    );

    act(() => {
      void result.current.send("hi");
    });

    await waitFor(() => expect(mockConnectSSE).toHaveBeenCalled());
    expect(capturedCallbacks.url).toBe("/v2/chat");
  });

  test("accumulates response.output_text.delta into content", async () => {
    const { result } = renderHook(() => useAgentChat({ agent: "helper" }));

    act(() => {
      void result.current.send("hi");
    });

    await waitFor(() => expect(capturedCallbacks.onMessage).toBeDefined());

    await act(async () => {
      await emit(
        JSON.stringify({
          type: "response.output_text.delta",
          delta: "Hello, ",
        }),
      );
      await emit(
        JSON.stringify({ type: "response.output_text.delta", delta: "world" }),
      );
    });

    expect(result.current.content).toBe("Hello, world");
  });

  test("captures threadId from appkit.metadata and reuses it on next send()", async () => {
    const { result } = renderHook(() => useAgentChat({ agent: "helper" }));

    act(() => {
      void result.current.send("first");
    });
    await waitFor(() => expect(capturedCallbacks.onMessage).toBeDefined());

    await act(async () => {
      await emit(
        JSON.stringify({
          type: "appkit.metadata",
          data: { threadId: "t-123" },
        }),
      );
    });

    expect(result.current.threadId).toBe("t-123");

    // End the first stream so the next send() opens a new SSE.
    await act(async () => {
      resolveStream?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    mockConnectSSE.mockClear();
    act(() => {
      void result.current.send("second");
    });
    await waitFor(() => expect(mockConnectSSE).toHaveBeenCalled());

    expect(capturedCallbacks.payload).toEqual({
      message: "second",
      agent: "helper",
      threadId: "t-123",
    });
  });

  test("onEvent is invoked for every parsed event", async () => {
    const onEvent = vi.fn();
    const { result } = renderHook(() =>
      useAgentChat({ agent: "helper", onEvent }),
    );

    act(() => {
      void result.current.send("hi");
    });
    await waitFor(() => expect(capturedCallbacks.onMessage).toBeDefined());

    await act(async () => {
      await emit(
        JSON.stringify({ type: "response.output_text.delta", delta: "a" }),
      );
      await emit(
        JSON.stringify({
          type: "response.output_item.added",
          item: { type: "function_call", name: "get_weather", arguments: "{}" },
        }),
      );
    });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "response.output_text.delta",
        delta: "a",
      }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "response.output_item.added",
        item: expect.objectContaining({ name: "get_weather" }),
      }),
    );
  });

  test("throwing onEvent handler does not break the stream", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("handler bug");
    });
    const { result } = renderHook(() =>
      useAgentChat({ agent: "helper", onEvent }),
    );

    act(() => {
      void result.current.send("hi");
    });
    await waitFor(() => expect(capturedCallbacks.onMessage).toBeDefined());

    await act(async () => {
      await emit(
        JSON.stringify({ type: "response.output_text.delta", delta: "x" }),
      );
    });

    // Despite onEvent throwing, content still accumulated.
    expect(result.current.content).toBe("x");
  });

  test("malformed event payloads are skipped silently", async () => {
    const onEvent = vi.fn();
    const { result } = renderHook(() =>
      useAgentChat({ agent: "helper", onEvent }),
    );

    act(() => {
      void result.current.send("hi");
    });
    await waitFor(() => expect(capturedCallbacks.onMessage).toBeDefined());

    await act(async () => {
      await emit("not-json");
      await emit("[DONE]");
      await emit("");
      await emit(
        JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
      );
    });

    expect(result.current.content).toBe("ok");
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test("isStreaming toggles around the connectSSE lifecycle", async () => {
    const { result } = renderHook(() => useAgentChat({ agent: "helper" }));

    expect(result.current.isStreaming).toBe(false);

    act(() => {
      void result.current.send("hi");
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    await act(async () => {
      resolveStream?.();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
  });

  test("reset() clears content, events, threadId, and aborts in-flight stream", async () => {
    const { result } = renderHook(() => useAgentChat({ agent: "helper" }));

    act(() => {
      void result.current.send("hi");
    });
    await waitFor(() => expect(capturedCallbacks.onMessage).toBeDefined());

    await act(async () => {
      await emit(
        JSON.stringify({ type: "appkit.metadata", data: { threadId: "t-1" } }),
      );
      await emit(
        JSON.stringify({ type: "response.output_text.delta", delta: "x" }),
      );
    });

    expect(result.current.threadId).toBe("t-1");
    expect(result.current.content).toBe("x");

    const signal = capturedCallbacks.signal;
    expect(signal?.aborted).toBe(false);

    act(() => {
      result.current.reset();
    });

    expect(signal?.aborted).toBe(true);
    expect(result.current.content).toBe("");
    expect(result.current.events).toEqual([]);
    expect(result.current.threadId).toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });

  test("send() while a previous stream is in flight aborts the previous one", async () => {
    const { result } = renderHook(() => useAgentChat({ agent: "helper" }));

    act(() => {
      void result.current.send("first");
    });
    await waitFor(() => expect(capturedCallbacks.onMessage).toBeDefined());
    const firstSignal = capturedCallbacks.signal;

    act(() => {
      void result.current.send("second");
    });
    expect(firstSignal?.aborted).toBe(true);
  });

  test("onError surfaces a string error message", async () => {
    const { result } = renderHook(() => useAgentChat({ agent: "helper" }));

    act(() => {
      void result.current.send("hi");
    });
    await waitFor(() => expect(capturedCallbacks.onError).toBeDefined());

    await act(async () => {
      capturedCallbacks.onError?.(new Error("upstream 500"));
      resolveStream?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.error).toBe("upstream 500");
    expect(result.current.isStreaming).toBe(false);
  });
});
