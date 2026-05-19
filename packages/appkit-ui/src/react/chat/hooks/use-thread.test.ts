import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useThread } from "./use-thread";

const API = "/api/agents/threads";

function makeSerializedThread(id: string) {
  const updatedAt = "2026-01-02T03:04:05.000Z";
  return {
    id,
    userId: "user-1",
    createdAt: updatedAt,
    updatedAt,
    messages: [
      {
        id: "m-1",
        role: "user" as const,
        content: "hi",
        createdAt: updatedAt,
      },
    ],
  };
}

describe("useThread", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makeSerializedThread("t-1")), {
        status: 200,
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("idle when threadId is null — no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() =>
      useThread({ api: API, threadId: null }),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.thread).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("fetches GET /threads/:id when threadId is set and revives dates", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() =>
      useThread({ api: API, threadId: "t-1" }),
    );

    await waitFor(() => {
      expect(result.current.thread).not.toBeNull();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      `${API}/t-1`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.current.thread?.id).toBe("t-1");
    expect(result.current.thread?.createdAt).toBeInstanceOf(Date);
    expect(result.current.thread?.messages[0].createdAt).toBeInstanceOf(Date);
    expect(result.current.error).toBeNull();
  });

  test("URL-encodes the threadId", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderHook(() => useThread({ api: API, threadId: "a/b c" }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        `${API}/a%2Fb%20c`,
        expect.any(Object),
      );
    });
  });

  test("404 -> thread:null + raw Error with server message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Thread not found" }), {
        status: 404,
      }),
    );

    const { result } = renderHook(() =>
      useThread({ api: API, threadId: "missing" }),
    );

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });
    expect(result.current.error?.message).toBe("Thread not found");
    expect(result.current.thread).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  test("surfaces non-404 server errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Boom" }), { status: 500 }),
    );

    const { result } = renderHook(() =>
      useThread({ api: API, threadId: "t-1" }),
    );

    await waitFor(() => {
      expect(result.current.error?.message).toBe("Boom");
    });
  });

  test("refresh() re-runs the request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() =>
      useThread({ api: API, threadId: "t-1" }),
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("aborts in-flight request on unmount", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    const { unmount } = renderHook(() =>
      useThread({ api: API, threadId: "t-1" }),
    );

    await waitFor(() => expect(capturedSignal).toBeDefined());
    const signal = capturedSignal as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
  });

  test("changing threadId triggers a new fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { rerender } = renderHook(
      ({ threadId }: { threadId: string }) => useThread({ api: API, threadId }),
      { initialProps: { threadId: "t-1" } },
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    rerender({ threadId: "t-2" });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(fetchSpy.mock.calls[1][0]).toBe(`${API}/t-2`);
  });
});
