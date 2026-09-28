import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DatabaseApiError } from "@/js/database/errors";

import {
  mockDatabaseFetch,
  nextTick,
  type PendingRequest,
  page,
  publishDatabase,
  resetDatabaseTestEnvironment,
  useDatabaseList,
} from "./database-test-utils";

describe("useDatabaseList", () => {
  let requests: PendingRequest[];
  let fetchMock: ReturnType<typeof mockDatabaseFetch>["fetchMock"];

  beforeEach(() => {
    ({ requests, fetchMock } = mockDatabaseFetch());
    publishDatabase({
      "notes.list": "/api/database/notes",
      "boards.list": "/api/database/boards",
    });
  });

  afterEach(resetDatabaseTestEnvironment);

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

  test("null params hold the read idle until the params they depend on exist", () => {
    const { result, rerender } = renderHook(
      ({ boardId }: { boardId: number | undefined }) =>
        useDatabaseList(
          "notes",
          boardId === undefined ? null : { where: { board_id: boardId } },
        ),
      { initialProps: { boardId: undefined as number | undefined } },
    );

    expect(result.current).toMatchObject({
      data: null,
      loading: false,
      error: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ boardId: 7 });
    expect(requests[0]?.url).toContain("board_id%22%3A7");
    expect(result.current.loading).toBe(true);
  });

  test("does not encode an incomplete filter while disabled", () => {
    const { rerender } = renderHook(
      ({ boardId }: { boardId: number | undefined }) =>
        useDatabaseList(
          "notes",
          { where: { board_id: boardId } },
          { enabled: boardId !== undefined },
        ),
      { initialProps: { boardId: undefined as number | undefined } },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ boardId: 7 });
    expect(requests[0]?.url).toContain("board_id%22%3A7");
  });

  test("reports an incomplete enabled filter without sending a request", () => {
    const { result } = renderHook(() =>
      useDatabaseList("notes", { where: { board_id: undefined } }),
    );

    expect(result.current.error).toMatchObject({
      code: "INVALID_REQUEST",
      status: null,
    });
    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("keeps an INVALID_REQUEST error stable, so an effect keyed on it runs once", () => {
    const seen: unknown[] = [];
    const { result, rerender } = renderHook(() => {
      const read = useDatabaseList("notes", { where: { board_id: undefined } });
      useEffect(() => {
        seen.push(read.error);
      }, [read.error]);
      return read;
    });
    const first = result.current.error;

    rerender();
    rerender();

    expect(result.current.error).toBe(first);
    expect(seen).toEqual([first]);
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

  test("new params show null while they load, unless keepPreviousData holds the last page", async () => {
    const { result, rerender } = renderHook(
      ({ offset, keep }: { offset: number; keep: boolean }) =>
        useDatabaseList(
          "notes",
          { limit: 1, offset },
          { keepPreviousData: keep },
        ),
      { initialProps: { offset: 0, keep: false } },
    );
    await act(async () => requests[0]?.respond(page({ id: 0 })));
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ offset: 1, keep: false });
    expect(result.current).toMatchObject({ data: null, loading: true });
    await act(async () => requests[1]?.respond(page({ id: 1 })));
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ offset: 2, keep: true });
    expect(result.current).toMatchObject({
      data: page({ id: 1 }),
      loading: true,
      error: null,
    });
    await act(async () => requests[2]?.respond(page({ id: 2 })));
    await waitFor(() => expect(result.current.data).toEqual(page({ id: 2 })));
  });

  test("keepPreviousData does not show the last page beside a failure for the new params", async () => {
    const { result, rerender } = renderHook(
      ({ offset }: { offset: number }) =>
        useDatabaseList(
          "notes",
          { limit: 1, offset },
          { keepPreviousData: true },
        ),
      { initialProps: { offset: 0 } },
    );
    await act(async () => requests[0]?.respond(page({ id: 0 })));
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ offset: 1 });
    await act(async () => requests[1]?.respond({ error: "boom" }, 500));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBeNull();
    expect(result.current.error).toMatchObject({ code: "INTERNAL" });
  });

  test("a shape function checks each row once per response and types the result", async () => {
    const parse = vi.fn((row: unknown) => {
      const { id } = row as { id: unknown };
      if (typeof id !== "number") throw new TypeError(`bad id ${String(id)}`);
      return { id, label: `#${id}` };
    });
    const { result, rerender } = renderHook(() =>
      // An inline arrow: a new function on every render.
      useDatabaseList("notes", {}, { shape: (row) => parse(row) }),
    );
    await act(async () => requests[0]?.respond(page({ id: 1 }, { id: 2 })));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual({
      items: [
        { id: 1, label: "#1" },
        { id: 2, label: "#2" },
      ],
      limit: 50,
      offset: 0,
    });
    const shaped = result.current.data;
    rerender();
    rerender();
    expect(result.current.data).toBe(shaped);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  test("a row that fails its shape fails the read with INTERNAL, without echoing the row", async () => {
    const { result } = renderHook(() =>
      useDatabaseList(
        "notes",
        {},
        {
          shape: (row) => {
            throw new TypeError(`secret ${JSON.stringify(row)}`);
          },
        },
      ),
    );
    await act(async () => requests[0]?.respond(page({ id: "token" })));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeInstanceOf(DatabaseApiError);
    expect(result.current.error).toMatchObject({
      code: "INTERNAL",
      status: null,
      message: "Database response does not match the read's shape",
    });
    expect(result.current.error?.message).not.toContain("token");
    expect(result.current.error?.cause).toBeInstanceOf(TypeError);
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
