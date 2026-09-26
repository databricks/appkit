import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { _resetConfigCache } from "@/js/config";
import { DatabaseApiError } from "@/js/database/errors";

import { resetDatabaseRequestStore } from "../database-request-store";
import { useDatabaseList as typedUseDatabaseList } from "../use-database-list";
import type { DatabaseReadResult } from "../use-database-read";

// This package has no generated registry, so every entity name is `never`
// here. The typed surface is compiled in use-database.types.test.ts; these
// cover the request lifecycle.
const useDatabaseList = typedUseDatabaseList as unknown as (
  entity: string,
  params?: object,
  options?: { enabled?: boolean },
) => DatabaseReadResult<{ items: unknown[]; limit: number; offset: number }>;

interface PendingRequest {
  url: string;
  signal: AbortSignal | undefined;
  respond(body: unknown, status?: number): void;
}

function page(...items: unknown[]) {
  return { items, limit: 50, offset: 0 };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Let the deferred teardown of a released entry run. */
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useDatabaseList", () => {
  let requests: PendingRequest[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requests = [];
    // Each request stays open until the test answers it, and ignores aborts,
    // so a test can deliver a completion after it was superseded.
    fetchMock = vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({
            url,
            signal: init.signal ?? undefined,
            respond: (body, status) => resolve(json(body, status)),
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.__appkit__ = {
      appName: "test",
      queries: {},
      endpoints: {
        database: {
          "notes.list": "/api/database/notes",
          "boards.list": "/api/database/boards",
        },
      },
      plugins: {},
    };
    resetDatabaseRequestStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__appkit__;
    _resetConfigCache();
  });

  test("reads the published route with the encoded query", async () => {
    const { result } = renderHook(() =>
      useDatabaseList("notes", { where: { board_id: 7 }, limit: 5 }),
    );

    expect(result.current).toMatchObject({
      data: null,
      loading: true,
      error: null,
    });
    expect(requests.map((request) => request.url)).toEqual([
      "/api/database/notes?where=%7B%22board_id%22%3A7%7D&limit=5",
    ]);

    await act(async () => requests[0]?.respond(page({ id: 1 })));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(page({ id: 1 }));
    expect(result.current.error).toBeNull();
  });

  test("is loading from its first render, before the request starts", () => {
    const loading: boolean[] = [];
    renderHook(() => {
      const read = useDatabaseList("notes");
      loading.push(read.loading);
      return read;
    });

    expect(loading[0]).toBe(true);
  });

  test("shares one request between hooks with equal params", async () => {
    const first = renderHook(() =>
      useDatabaseList("notes", { order: { id: "desc" }, limit: 5 }),
    );
    // A different key order encodes to the same query.
    const second = renderHook(() =>
      useDatabaseList("notes", { limit: 5, order: { id: "desc" } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => requests[0]?.respond(page({ id: 2 })));

    await waitFor(() =>
      expect(first.result.current.data).toEqual(page({ id: 2 })),
    );
    expect(second.result.current.data).toEqual(page({ id: 2 }));
  });

  test("does not refetch when an inline params literal re-renders", () => {
    const { rerender } = renderHook(
      ({ limit }: { limit: number }) => useDatabaseList("notes", { limit }),
      { initialProps: { limit: 5 } },
    );

    rerender({ limit: 5 });
    rerender({ limit: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ limit: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[1]?.url).toBe("/api/database/notes?limit=10");
  });

  test("sends nothing while disabled, and reads once enabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useDatabaseList("notes", {}, { enabled }),
      { initialProps: { enabled: false } },
    );

    expect(result.current).toMatchObject({
      data: null,
      loading: false,
      error: null,
    });
    act(() => result.current.refetch());
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(true);
  });

  test("refetch aborts the in-flight request, sends it again, and keeps the last page visible", async () => {
    const { result } = renderHook(() => useDatabaseList("notes"));
    await act(async () => requests[0]?.respond(page({ id: 1 })));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.refetch());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({
      data: page({ id: 1 }),
      loading: true,
    });

    act(() => result.current.refetch());
    expect(requests[1]?.signal?.aborted).toBe(true);
    expect(requests[2]?.signal?.aborted).toBe(false);

    await act(async () => requests[2]?.respond(page({ id: 1 }, { id: 2 })));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(page({ id: 1 }, { id: 2 }));
  });

  test("ignores completions that arrive after their request was superseded", async () => {
    const { result } = renderHook(() => useDatabaseList("notes"));
    act(() => result.current.refetch());
    act(() => result.current.refetch());

    await act(async () => requests[2]?.respond(page({ id: "fresh" })));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => requests[0]?.respond(page({ id: "stale" })));
    await act(async () => requests[1]?.respond({ error: "late" }, 500));

    expect(result.current.data).toEqual(page({ id: "fresh" }));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  test("aborts the request once the last subscriber unmounts", async () => {
    const first = renderHook(() => useDatabaseList("notes"));
    const second = renderHook(() => useDatabaseList("notes"));

    first.unmount();
    await nextTick();
    expect(requests[0]?.signal?.aborted).toBe(false);

    second.unmount();
    expect(requests[0]?.signal?.aborted).toBe(false);
    await nextTick();
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  test("reuses the in-flight request across a StrictMode remount", async () => {
    const { result } = renderHook(() => useDatabaseList("notes"), {
      wrapper: StrictMode,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await nextTick();
    expect(requests[0]?.signal?.aborted).toBe(false);

    await act(async () => requests[0]?.respond(page({ id: 3 })));
    await waitFor(() => expect(result.current.data).toEqual(page({ id: 3 })));
  });

  test("reports a failure as a DatabaseApiError and keeps the last page after a failed refetch", async () => {
    const { result } = renderHook(() => useDatabaseList("notes"));
    await act(async () => requests[0]?.respond(page({ id: 1 })));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.refetch());
    await act(async () =>
      requests[1]?.respond(
        {
          error: "Invalid database request",
          details: [{ path: ["where"], message: "Unknown column" }],
        },
        400,
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(DatabaseApiError);
    expect(result.current.error).toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
      details: [{ path: ["where"], message: "Unknown column" }],
    });
    expect(result.current.data).toEqual(page({ id: 1 }));
  });

  test("reports NOT_EXPOSED for an unpublished route without sending a request", () => {
    const { result, rerender } = renderHook(() => useDatabaseList("secrets"));
    const first = result.current.error;

    expect(first).toBeInstanceOf(DatabaseApiError);
    expect(first).toMatchObject({ code: "NOT_EXPOSED", status: null });
    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // The error is stable across renders, so effects keyed on it do not loop.
    rerender();
    expect(result.current.error).toBe(first);
  });
});
