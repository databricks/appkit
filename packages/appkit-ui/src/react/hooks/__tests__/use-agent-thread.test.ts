import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// --- connectSSE harness (drives useAgentChat's streaming) ---
let capturedOnMessage: ((msg: { data: string }) => Promise<void>) | undefined;
let resolveStream: (() => void) | null = null;

const mockConnectSSE = vi.fn();

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

import { useAgentThread } from "../use-agent-thread";

async function emit(data: string) {
  await capturedOnMessage?.({ data });
}

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  // Re-establish the impl each test — restoreAllMocks() in afterEach would
  // otherwise strip it, making connectSSE resolve to undefined instantly.
  mockConnectSSE.mockImplementation(
    (opts: { onMessage?: typeof capturedOnMessage }) => {
      capturedOnMessage = opts.onMessage;
      return new Promise<void>((resolve) => {
        resolveStream = resolve;
      });
    },
  );
});

afterEach(() => {
  capturedOnMessage = undefined;
  resolveStream = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("useAgentThread", () => {
  test("resumes a thread: loads history and keeps only user/assistant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJson({
        id: "t1",
        messages: [
          { id: "m1", role: "user", content: "hi" },
          { id: "m2", role: "assistant", content: "hello" },
          { id: "m3", role: "system", content: "system prompt" },
          { id: "m4", role: "tool", content: "{}" },
        ],
      }),
    );

    const { result } = renderHook(() =>
      useAgentThread("t1", { agent: "helper" }),
    );

    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(result.current.messages[1].content).toBe("hello");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/threads/t1",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  test("new thread: send appends the user turn, streams, and commits the assistant turn", async () => {
    const { result } = renderHook(() =>
      useAgentThread(undefined, { agent: "helper" }),
    );
    expect(result.current.messages).toEqual([]);

    // Send a turn — user message appears immediately.
    await act(async () => {
      void result.current.send("what is the weather?");
    });
    await waitFor(() => expect(mockConnectSSE).toHaveBeenCalled());
    expect(result.current.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "what is the weather?",
      }),
    ]);

    // Server assigns a thread id, then streams the answer.
    await act(async () => {
      await emit(
        JSON.stringify({
          type: "appkit.metadata",
          data: { threadId: "srv-1" },
        }),
      );
      await emit(
        JSON.stringify({ type: "response.output_text.delta", delta: "Sunny" }),
      );
    });

    expect(result.current.threadId).toBe("srv-1");
    // Live streaming bubble is visible mid-turn.
    expect(result.current.messages.at(-1)).toEqual(
      expect.objectContaining({ role: "assistant", content: "Sunny" }),
    );
    expect(result.current.isStreaming).toBe(true);

    // End the stream → the assistant turn is committed (survives isStreaming=false).
    await act(async () => {
      resolveStream?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "what is the weather?",
      }),
      expect.objectContaining({ role: "assistant", content: "Sunny" }),
    ]);
  });

  test("forwards the resumed threadId so the first send continues the thread", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJson({ id: "t9", messages: [] }),
    );
    const { result } = renderHook(() =>
      useAgentThread("t9", { agent: "helper" }),
    );
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    await act(async () => {
      void result.current.send("continue");
    });
    await waitFor(() => expect(mockConnectSSE).toHaveBeenCalled());

    const payload = mockConnectSSE.mock.calls[0][0].payload;
    expect(payload).toEqual({
      message: "continue",
      agent: "helper",
      threadId: "t9",
    });
  });

  test("caches a loaded thread — re-selecting it does not refetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const id = decodeURIComponent(String(input).split("/threads/")[1]);
        return Promise.resolve(
          okJson({
            id,
            messages: [{ id: `${id}-m1`, role: "user", content: `hi ${id}` }],
          }),
        );
      });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAgentThread(id, { agent: "helper" }),
      { initialProps: { id: "t1" } },
    );
    await waitFor(() =>
      expect(result.current.messages[0]?.content).toBe("hi t1"),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    rerender({ id: "t2" });
    await waitFor(() =>
      expect(result.current.messages[0]?.content).toBe("hi t2"),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Back to t1 — served from cache, no third fetch.
    rerender({ id: "t1" });
    await waitFor(() =>
      expect(result.current.messages[0]?.content).toBe("hi t1"),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("reset clears the transcript", async () => {
    const { result } = renderHook(() =>
      useAgentThread(undefined, { agent: "helper" }),
    );
    await act(async () => {
      void result.current.send("hi");
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    act(() => result.current.reset());
    expect(result.current.messages).toEqual([]);
    expect(result.current.threadId).toBeNull();
  });
});
