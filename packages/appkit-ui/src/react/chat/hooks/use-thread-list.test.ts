import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useThreadList } from "./use-thread-list";

const API = "/api/agents/threads";

function makeSerializedThread(id: string, updatedAt: string) {
  return {
    id,
    userId: "user-1",
    messages: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("useThreadList", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ threads: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("auto-fetches on mount and revives dates", async () => {
    const updatedAt = "2026-01-02T03:04:05.000Z";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          threads: [makeSerializedThread("t-1", updatedAt)],
        }),
        { status: 200 },
      ),
    );

    const { result } = renderHook(() => useThreadList({ api: API }));

    await waitFor(() => {
      expect(result.current.threads).not.toBeNull();
    });

    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads?.[0].id).toBe("t-1");
    expect(result.current.threads?.[0].updatedAt).toBeInstanceOf(Date);
    expect(result.current.threads?.[0].updatedAt.toISOString()).toBe(updatedAt);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("hits the configured api URL with GET + Accept: application/json", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderHook(() => useThreadList({ api: API }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        API,
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Accept: "application/json" }),
        }),
      );
    });
  });

  test("skips fetch when enabled is false", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderHook(() => useThreadList({ api: API, enabled: false }));

    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("surfaces server error message on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Boom" }), { status: 500 }),
    );

    const { result } = renderHook(() => useThreadList({ api: API }));

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });
    expect(result.current.error?.message).toBe("Boom");
    expect(result.current.loading).toBe(false);
    expect(result.current.threads).toBeNull();
  });

  test("falls back to HTTP status when error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 503 }),
    );

    const { result } = renderHook(() => useThreadList({ api: API }));

    await waitFor(() => {
      expect(result.current.error?.message).toBe("HTTP 503");
    });
  });

  test("refresh() re-runs the request", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ threads: [] }), { status: 200 }),
      );

    const { result } = renderHook(() => useThreadList({ api: API }));

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
      // Never resolves; we only care about the abort signal.
      return new Promise<Response>(() => {});
    });

    const { unmount } = renderHook(() => useThreadList({ api: API }));

    await waitFor(() => expect(capturedSignal).toBeDefined());
    const signal = capturedSignal as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
  });
});
