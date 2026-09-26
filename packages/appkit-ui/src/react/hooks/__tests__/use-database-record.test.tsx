import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { _resetConfigCache } from "@/js/config";
import { DatabaseApiError } from "@/js/database/errors";

import { resetDatabaseRequestStore } from "../database-request-store";
import type { DatabaseReadResult } from "../use-database-read";
import { useDatabaseRecord as typedUseDatabaseRecord } from "../use-database-record";

// This package has no generated registry, so every entity name is `never`
// here. The typed surface is compiled in use-database.types.test.ts.
const useDatabaseRecord = typedUseDatabaseRecord as unknown as (
  entity: string,
  id: string | number | bigint | null | undefined,
  params?: object,
  options?: { enabled?: boolean },
) => DatabaseReadResult<Record<string, unknown>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useDatabaseRecord", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      const id = decodeURIComponent(url.split("?")[0]?.split("/").pop() ?? "");
      return json({ id, body: `note ${id}` });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.__appkit__ = {
      appName: "test",
      queries: {},
      endpoints: {
        database: {
          "notes.list": "/api/database/notes",
          "notes.detail": "/api/database/notes/:id",
          "events.list": "/api/database/events",
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

  test("reports a missing row as NOT_FOUND", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: "Database record not found" }, 404),
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
