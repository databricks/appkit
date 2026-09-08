import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useAgentThreads } from "../use-agent-threads";

const ISO = "2026-05-05T10:00:00.000Z";

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route fetch by method + path so multi-call tests get fresh responses. */
function routeFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/threads")) {
      return Promise.resolve(
        okJson({
          threads: [
            {
              id: "t1",
              title: "Weather",
              messageCount: 2,
              createdAt: ISO,
              updatedAt: ISO,
            },
            {
              id: "t2",
              title: "",
              messageCount: 0,
              createdAt: ISO,
              updatedAt: ISO,
            },
          ],
        }),
      );
    }
    // DELETE / PATCH on /threads/:id
    return Promise.resolve(okJson({ ok: true }));
  });
}

afterEach(() => vi.restoreAllMocks());

describe("useAgentThreads", () => {
  test("loads summaries on mount and revives dates", async () => {
    const fetchSpy = routeFetch();
    const { result } = renderHook(() => useAgentThreads());

    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/agents/threads",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result.current.threads[0].updatedAt).toBeInstanceOf(Date);
    expect(result.current.threads[0].updatedAt.toISOString()).toBe(ISO);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("basePath option is honored", async () => {
    const fetchSpy = routeFetch();
    const { result } = renderHook(() =>
      useAgentThreads({ basePath: "/custom/agents" }),
    );
    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/custom/agents/threads",
      expect.anything(),
    );
  });

  test("deleteThread removes optimistically and calls DELETE", async () => {
    const fetchSpy = routeFetch();
    const { result } = renderHook(() => useAgentThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    await act(async () => {
      await result.current.deleteThread("t1");
    });

    expect(result.current.threads.map((t) => t.id)).toEqual(["t2"]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/agents/threads/t1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("renameThread updates the title optimistically and PATCHes", async () => {
    const fetchSpy = routeFetch();
    const { result } = renderHook(() => useAgentThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    await act(async () => {
      await result.current.renameThread("t1", "Renamed");
    });

    expect(result.current.threads.find((t) => t.id === "t1")?.title).toBe(
      "Renamed",
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/agents/threads/t1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed" }),
      }),
    );
  });

  test("rolls back a failed delete and surfaces an error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Promise.resolve(
          okJson({
            threads: [
              {
                id: "t1",
                title: "x",
                messageCount: 1,
                createdAt: ISO,
                updatedAt: ISO,
              },
            ],
          }),
        );
      }
      return Promise.resolve(okJson({ error: "boom" }, 500));
    });
    const { result } = renderHook(() => useAgentThreads());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    await act(async () => {
      await result.current.deleteThread("t1");
    });

    // Rolled back to the server state (refetch), and an error recorded.
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(result.current.error).toBeTruthy();
  });

  test("surfaces a load error on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJson({ error: "nope" }, 500),
    );
    const { result } = renderHook(() => useAgentThreads());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.threads).toEqual([]);
  });
});
