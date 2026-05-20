import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useDeleteThread } from "./use-delete-thread";

const API = "/api/agents/threads";

describe("useDeleteThread", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("does not call fetch on mount", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderHook(() => useDeleteThread({ api: API }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("issues DELETE against api + encoded id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useDeleteThread({ api: API }));

    await act(async () => {
      await result.current.deleteThread("t-1");
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      `${API}/t-1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("URL-encodes the threadId", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useDeleteThread({ api: API }));

    await act(async () => {
      await result.current.deleteThread("a/b c");
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      `${API}/a%2Fb%20c`,
      expect.any(Object),
    );
  });

  test("toggles loading + error around a successful call", async () => {
    const { result } = renderHook(() => useDeleteThread({ api: API }));

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.deleteThread("t-1");
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("rejects + surfaces server error on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Thread not found" }), {
        status: 404,
      }),
    );

    const { result } = renderHook(() => useDeleteThread({ api: API }));

    await act(async () => {
      await expect(result.current.deleteThread("missing")).rejects.toThrow(
        "Thread not found",
      );
    });

    expect(result.current.error?.message).toBe("Thread not found");
    expect(result.current.loading).toBe(false);
  });

  test("falls back to HTTP status when error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 503 }),
    );

    const { result } = renderHook(() => useDeleteThread({ api: API }));

    await act(async () => {
      await expect(result.current.deleteThread("t-1")).rejects.toThrow(
        "HTTP 503",
      );
    });
  });

  test("forwards extra headers from options", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() =>
      useDeleteThread({ api: API, headers: { "X-Token": "abc" } }),
    );

    await act(async () => {
      await result.current.deleteThread("t-1");
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Token": "abc" }),
      }),
    );
  });

  test("clears error on the next successful call", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Boom" }), { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true }), { status: 200 }),
      );

    const { result } = renderHook(() => useDeleteThread({ api: API }));

    await act(async () => {
      await expect(result.current.deleteThread("t-1")).rejects.toThrow("Boom");
    });
    expect(result.current.error?.message).toBe("Boom");

    await act(async () => {
      await result.current.deleteThread("t-1");
    });
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
