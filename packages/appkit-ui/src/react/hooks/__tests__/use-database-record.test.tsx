import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DatabaseApiError } from "@/js/database/errors";

import {
  invalidateDatabaseReads,
  nextTick,
  publishDatabase,
  reply,
  resetDatabaseTestEnvironment,
  useDatabaseRecord,
} from "./database-test-utils";

describe("useDatabaseRecord", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Answers every detail read at once with a row named after its id.
    fetchMock = vi.fn(async (url: string) => {
      const id = decodeURIComponent(url.split("?")[0]?.split("/").pop() ?? "");
      return reply({ id, body: `note ${id}` });
    });
    vi.stubGlobal("fetch", fetchMock);
    publishDatabase({
      "notes.list": "/api/database/notes",
      "notes.detail": "/api/database/notes/:id",
      "events.list": "/api/database/events",
    });
  });

  afterEach(resetDatabaseTestEnvironment);

  test("reads the detail route with the id as one path segment and the encoded query", async () => {
    const { result } = renderHook(() =>
      useDatabaseRecord("notes", "a/b c", {
        include: { note_events: { limit: 5 } },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/database/notes/a%2Fb%20c?include=%7B%22note_events%22%3A%7B%22limit%22%3A5%7D%7D",
    );
    expect(result.current.data).toEqual({ id: "a/b c", body: "note a/b c" });
  });

  test("waits without a request while the id is null or undefined", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: number | null | undefined }) =>
        useDatabaseRecord("notes", id),
      { initialProps: { id: null as number | null | undefined } },
    );

    expect(result.current).toMatchObject({
      data: null,
      loading: false,
      error: null,
    });
    rerender({ id: undefined });
    act(() => result.current.refetch());
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ id: 7 });
    await waitFor(() =>
      expect(result.current.data).toEqual({ id: "7", body: "note 7" }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/database/notes/7");
  });

  test.each(["", ".", ".."])(
    "refuses the id %j, which would resolve to another route, without a request",
    (id) => {
      const { result, rerender } = renderHook(() =>
        useDatabaseRecord("notes", id),
      );
      const first = result.current.error;

      expect(first).toMatchObject({ code: "INVALID_REQUEST", status: null });
      expect(result.current).toMatchObject({ data: null, loading: false });
      expect(fetchMock).not.toHaveBeenCalled();
      rerender();
      expect(result.current.error).toBe(first);
    },
  );

  test("does not encode incomplete includes while the record is disabled", () => {
    const { result, rerender } = renderHook(
      ({ id, author }: { id: number | null; author: string | undefined }) =>
        useDatabaseRecord("notes", id, {
          include: { note_events: { where: { author } } },
        }),
      {
        initialProps: {
          id: null as number | null,
          author: undefined as string | undefined,
        },
      },
    );

    expect(result.current.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ id: 7, author: "ada" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("reads the new record when the id changes", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useDatabaseRecord("notes", id),
      { initialProps: { id: 1 } },
    );
    await waitFor(() => expect(result.current.data).toMatchObject({ id: "1" }));

    rerender({ id: 2 });
    expect(result.current).toMatchObject({ data: null, loading: true });
    await waitFor(() => expect(result.current.data).toMatchObject({ id: "2" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("keepPreviousData shows the previous record while the next id loads", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) =>
        useDatabaseRecord("notes", id, {}, { keepPreviousData: true }),
      { initialProps: { id: 1 } },
    );
    await waitFor(() => expect(result.current.data).toMatchObject({ id: "1" }));

    rerender({ id: 2 });
    expect(result.current).toMatchObject({
      data: { id: "1" },
      loading: true,
    });
    await waitFor(() => expect(result.current.data).toMatchObject({ id: "2" }));
  });

  test("reports a missing row as NOT_FOUND", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ error: "Database record not found" }, 404),
    );

    const { result } = renderHook(() => useDatabaseRecord("notes", 404));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeInstanceOf(DatabaseApiError);
    expect(result.current.error).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      message: "Database record not found",
    });
  });

  test("clears the row when a refetch finds it deleted, but keeps it through other failures", async () => {
    const { result } = renderHook(() => useDatabaseRecord("notes", 1));
    await waitFor(() => expect(result.current.data).toMatchObject({ id: "1" }));

    fetchMock.mockResolvedValueOnce(reply({ error: "Unavailable" }, 503));
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toMatchObject({ id: "1" });
    expect(result.current.error).toMatchObject({ status: 503 });

    // The row was deleted elsewhere; the restart after that write finds it gone.
    fetchMock.mockResolvedValueOnce(
      reply({ error: "Database record not found" }, 404),
    );
    await act(() => invalidateDatabaseReads());
    expect(result.current.data).toBeNull();
    expect(result.current.error).toMatchObject({ code: "NOT_FOUND" });
  });

  test("applies a shape function to the record", async () => {
    const { result } = renderHook(() =>
      useDatabaseRecord(
        "notes",
        7,
        {},
        {
          shape: (row) => ({ title: String((row as { body: string }).body) }),
        },
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ title: "note 7" });
  });

  test("reads once under StrictMode and keeps the request across the remount", async () => {
    const { result } = renderHook(() => useDatabaseRecord("notes", 3), {
      wrapper: StrictMode,
    });

    await nextTick();
    await waitFor(() => expect(result.current.data).toMatchObject({ id: "3" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("reports NOT_EXPOSED for a table with no detail route, without a request", () => {
    const { result } = renderHook(() => useDatabaseRecord("events", 1));

    expect(result.current.error).toMatchObject({
      code: "NOT_EXPOSED",
      message: 'Database operation "events.detail" is not exposed',
    });
    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
