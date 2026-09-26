import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { _resetConfigCache } from "@/js/config";
import { DatabaseApiError } from "@/js/database/errors";

import {
  invalidateDatabaseReads as typedInvalidateDatabaseReads,
  resetDatabaseRequestStore,
} from "../database-request-store";
import { useDatabaseCreate as typedUseDatabaseCreate } from "../use-database-create";
import { useDatabaseDelete as typedUseDatabaseDelete } from "../use-database-delete";
import { useDatabaseList as typedUseDatabaseList } from "../use-database-list";
import type { DatabaseReadResult } from "../use-database-read";
import { useDatabaseUpdate as typedUseDatabaseUpdate } from "../use-database-update";
import type { DatabaseWriteState } from "../use-database-write";

// This package has no generated registry, so every entity name is `never`
// here. The typed surface is compiled in use-database.types.test.ts; these
// cover the write lifecycle.
type Row = Record<string, unknown>;
type Options = { invalidate?: boolean | readonly string[] };
const useDatabaseCreate = typedUseDatabaseCreate as unknown as (
  entity: string,
  options?: Options,
) => DatabaseWriteState<Row> & {
  create(values: object): Promise<Row | null>;
  reset(): void;
};
const useDatabaseUpdate = typedUseDatabaseUpdate as unknown as (
  entity: string,
  options?: Options,
) => DatabaseWriteState<Row> & {
  update(id: string | number, values: object): Promise<Row | null>;
  reset(): void;
};
const useDatabaseDelete = typedUseDatabaseDelete as unknown as (
  entity: string,
  options?: Options,
) => {
  remove(id: string | number): Promise<boolean>;
  loading: boolean;
  error: DatabaseApiError | null;
  reset(): void;
};
const invalidateDatabaseReads = typedInvalidateDatabaseReads as (
  scope?: boolean | readonly string[],
) => void;
const useDatabaseList = typedUseDatabaseList as unknown as (
  entity: string,
  params?: object,
  options?: { enabled?: boolean },
) => DatabaseReadResult<{ items: unknown[]; limit: number; offset: number }>;

interface PendingRequest {
  url: string;
  method: string;
  body: unknown;
  signal: AbortSignal | undefined;
  respond(body: unknown, status?: number): void;
}

function page(...items: unknown[]) {
  return { items, limit: 50, offset: 0 };
}

function reply(body: unknown, status: number): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("database write hooks", () => {
  let requests: PendingRequest[];
  let fetchMock: ReturnType<typeof vi.fn>;

  /** Requests to `method`, in the order they were sent. */
  const sent = (method: string) =>
    requests.filter((request) => request.method === method);

  beforeEach(() => {
    requests = [];
    // Each request stays open until the test answers it, so a test controls
    // the order completions arrive in.
    fetchMock = vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({
            url,
            method: init.method ?? "GET",
            body: typeof init.body === "string" ? JSON.parse(init.body) : null,
            signal: init.signal ?? undefined,
            respond: (body, status = 200) => resolve(reply(body, status)),
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
          "notes.create": "/api/database/notes",
          "notes.update": "/api/database/notes/:id",
          "notes.delete": "/api/database/notes/:id",
          "boards.list": "/api/database/boards",
          "note_events.list": "/api/database/note_events",
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

  /** Mount a notes read and a boards read, and answer both. */
  async function mountReads() {
    const reads = renderHook(() => ({
      notes: useDatabaseList("notes"),
      boards: useDatabaseList("boards"),
    }));
    await act(async () => {
      for (const request of sent("GET")) request.respond(page({ id: 1 }));
    });
    await waitFor(() =>
      expect(reads.result.current.boards.loading).toBe(false),
    );
    return reads;
  }

  test("create posts the values and moves from loading to the created row", async () => {
    const { result } = renderHook(() => useDatabaseCreate("notes"));
    expect(result.current).toMatchObject({
      data: null,
      loading: false,
      error: null,
    });

    let created!: Promise<Row | null>;
    act(() => {
      created = result.current.create({ board_id: 7, body: "hi" });
    });

    expect(result.current.loading).toBe(true);
    expect(sent("POST")).toMatchObject([
      { url: "/api/database/notes", body: { board_id: 7, body: "hi" } },
    ]);

    await act(async () => sent("POST")[0]?.respond({ id: 1, body: "hi" }, 201));

    await expect(created).resolves.toEqual({ id: 1, body: "hi" });
    expect(result.current).toMatchObject({
      data: { id: 1, body: "hi" },
      loading: false,
      error: null,
    });
  });

  test("a failed write resolves null and reports the DatabaseApiError, without rejecting", async () => {
    const { result } = renderHook(() => useDatabaseCreate("notes"));

    // No handler is attached: a rejection here would fail the run as unhandled.
    let failed!: Promise<Row | null>;
    act(() => {
      failed = result.current.create({ body: "" });
    });
    await act(async () =>
      sent("POST")[0]?.respond(
        {
          error: "Database request failed validation",
          details: [{ path: ["body"], message: "Must not be empty" }],
        },
        422,
      ),
    );

    await expect(failed).resolves.toBeNull();
    const { error } = result.current;
    expect(error).toBeInstanceOf(DatabaseApiError);
    expect(error).toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
      details: [{ path: ["body"], message: "Must not be empty" }],
    });
    expect(result.current).toMatchObject({ data: null, loading: false });

    // The next call starts clean.
    act(() => {
      void result.current.create({ body: "again" });
    });
    expect(result.current).toMatchObject({ loading: true, error: null });
  });

  test("update patches one id and delete removes one without a response body", async () => {
    const { result } = renderHook(() => ({
      update: useDatabaseUpdate("notes"),
      remove: useDatabaseDelete("notes"),
    }));

    let updated!: Promise<Row | null>;
    let removed!: Promise<boolean>;
    act(() => {
      updated = result.current.update.update(7, { body: "edited" });
      removed = result.current.remove.remove("a/b");
    });
    expect(result.current.update.loading).toBe(true);
    expect(result.current.remove.loading).toBe(true);
    expect(sent("PATCH")).toMatchObject([
      { url: "/api/database/notes/7", body: { body: "edited" } },
    ]);
    expect(sent("DELETE")).toMatchObject([
      { url: "/api/database/notes/a%2Fb", body: null },
    ]);

    await act(async () => {
      sent("PATCH")[0]?.respond({ id: 7, body: "edited" });
      sent("DELETE")[0]?.respond(null, 204);
    });

    await expect(updated).resolves.toEqual({ id: 7, body: "edited" });
    await expect(removed).resolves.toBe(true);
    expect(result.current.update).toMatchObject({
      data: { id: 7, body: "edited" },
      loading: false,
    });
    expect(result.current.remove).toMatchObject({
      loading: false,
      error: null,
    });
    expect(result.current.remove).not.toHaveProperty("data");
  });

  test("reports NOT_EXPOSED for a write the plugin did not publish, without a request", async () => {
    const { result } = renderHook(() => ({
      create: useDatabaseCreate("note_events"),
      remove: useDatabaseDelete("note_events"),
    }));

    let created!: Promise<Row | null>;
    let removed!: Promise<boolean>;
    await act(async () => {
      created = result.current.create.create({ action: "x" });
      removed = result.current.remove.remove(1);
      await Promise.all([created, removed]);
    });

    await expect(created).resolves.toBeNull();
    await expect(removed).resolves.toBe(false);
    expect(result.current.create.error).toMatchObject({
      code: "NOT_EXPOSED",
      status: null,
    });
    expect(result.current.remove.error).toMatchObject({
      code: "NOT_EXPOSED",
      status: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a successful write restarts every mounted read by default, keeping their data while they load", async () => {
    const reads = await mountReads();
    const writer = renderHook(() => useDatabaseCreate("notes"));
    expect(sent("GET")).toHaveLength(2);

    let created!: Promise<Row | null>;
    act(() => {
      created = writer.result.current.create({ body: "new" });
    });
    await act(async () => sent("POST")[0]?.respond({ id: 2 }, 201));
    await created;

    expect(sent("GET").map((request) => request.url)).toEqual([
      "/api/database/notes",
      "/api/database/boards",
      "/api/database/notes",
      "/api/database/boards",
    ]);
    expect(reads.result.current.notes).toMatchObject({
      data: page({ id: 1 }),
      loading: true,
    });

    await act(async () => {
      sent("GET")[2]?.respond(page({ id: 1 }, { id: 2 }));
      sent("GET")[3]?.respond(page({ id: 1 }));
    });
    await waitFor(() =>
      expect(reads.result.current.notes.data).toEqual(
        page({ id: 1 }, { id: 2 }),
      ),
    );
  });

  test("invalidate narrows the restart to reads of the named entities, or turns it off", async () => {
    await mountReads();
    const writers = renderHook(() => ({
      narrow: useDatabaseCreate("notes", { invalidate: ["notes"] }),
      none: useDatabaseCreate("notes", { invalidate: false }),
    }));

    let created!: Promise<Row | null>;
    act(() => {
      created = writers.result.current.narrow.create({ body: "a" });
    });
    await act(async () => sent("POST")[0]?.respond({ id: 2 }, 201));
    await created;
    expect(
      sent("GET")
        .slice(2)
        .map((request) => request.url),
    ).toEqual(["/api/database/notes"]);

    act(() => {
      created = writers.result.current.none.create({ body: "b" });
    });
    await act(async () => sent("POST")[1]?.respond({ id: 3 }, 201));
    await created;
    expect(sent("GET")).toHaveLength(3);
  });

  test("invalidateDatabaseReads refreshes reads after a write the hooks did not make", async () => {
    await mountReads();

    // A custom route or a databaseApi call changed boards rows.
    act(() => invalidateDatabaseReads(["boards"]));
    expect(
      sent("GET")
        .slice(2)
        .map((request) => request.url),
    ).toEqual(["/api/database/boards"]);

    // With no scope, every mounted read restarts.
    act(() => invalidateDatabaseReads());
    expect(
      sent("GET")
        .slice(3)
        .map((request) => request.url),
    ).toEqual(["/api/database/notes", "/api/database/boards"]);

    act(() => invalidateDatabaseReads(false));
    expect(sent("GET")).toHaveLength(5);
  });

  test("a failed write restarts no reads", async () => {
    await mountReads();
    const writer = renderHook(() => useDatabaseCreate("notes"));

    let failed!: Promise<Row | null>;
    act(() => {
      failed = writer.result.current.create({ body: "" });
    });
    await act(async () =>
      sent("POST")[0]?.respond({ error: "Database conflict" }, 409),
    );

    await expect(failed).resolves.toBeNull();
    expect(writer.result.current.error).toMatchObject({ code: "CONFLICT" });
    expect(sent("GET")).toHaveLength(2);
  });

  test("unmounting keeps the write in flight, and its success still restarts reads", async () => {
    await mountReads();
    const writer = renderHook(() => useDatabaseCreate("notes"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let created!: Promise<Row | null>;
    act(() => {
      created = writer.result.current.create({ body: "late" });
    });
    writer.unmount();

    // The write carries no abort signal: cancelling it would not undo it.
    expect(sent("POST")[0]?.signal).toBeUndefined();
    await act(async () => sent("POST")[0]?.respond({ id: 9 }, 201));

    await expect(created).resolves.toEqual({ id: 9 });
    expect(sent("GET")).toHaveLength(4);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  test("only the latest call reports its state; an earlier call still resolves", async () => {
    const { result } = renderHook(() => useDatabaseCreate("notes"));

    let first!: Promise<Row | null>;
    let second!: Promise<Row | null>;
    act(() => {
      first = result.current.create({ body: "first" });
      second = result.current.create({ body: "second" });
    });

    await act(async () => sent("POST")[1]?.respond({ id: 2 }, 201));
    await second;
    expect(result.current).toMatchObject({ data: { id: 2 }, loading: false });

    await act(async () => sent("POST")[0]?.respond({ id: 1 }, 201));
    await expect(first).resolves.toEqual({ id: 1 });
    expect(result.current).toMatchObject({ data: { id: 2 }, loading: false });

    // A stale failure does not replace the latest result either.
    let third!: Promise<Row | null>;
    let fourth!: Promise<Row | null>;
    act(() => {
      third = result.current.create({ body: "third" });
      fourth = result.current.create({ body: "fourth" });
    });
    await act(async () => sent("POST")[3]?.respond({ id: 4 }, 201));
    await fourth;
    await act(async () =>
      sent("POST")[2]?.respond({ error: "Database conflict" }, 409),
    );
    await expect(third).resolves.toBeNull();
    expect(result.current).toMatchObject({
      data: { id: 4 },
      loading: false,
      error: null,
    });
  });

  test("reset returns to idle and ignores the call in flight", async () => {
    const { result } = renderHook(() => useDatabaseCreate("notes"));

    let created!: Promise<Row | null>;
    act(() => {
      created = result.current.create({ body: "x" });
    });
    act(() => result.current.reset());
    expect(result.current).toMatchObject({
      data: null,
      loading: false,
      error: null,
    });

    await act(async () => sent("POST")[0]?.respond({ id: 1 }, 201));
    await expect(created).resolves.toEqual({ id: 1 });
    expect(result.current).toMatchObject({ data: null, loading: false });
  });

  test("keeps its write functions stable across renders with an inline entity list", () => {
    const { result, rerender } = renderHook(() => ({
      create: useDatabaseCreate("notes", { invalidate: ["notes", "boards"] }),
      remove: useDatabaseDelete("notes"),
    }));
    const { create } = result.current.create;
    const { remove, reset } = result.current.remove;

    rerender();

    expect(result.current.create.create).toBe(create);
    expect(result.current.remove.remove).toBe(remove);
    expect(result.current.remove.reset).toBe(reset);
  });

  test("reports its state under StrictMode", async () => {
    const { result } = renderHook(() => useDatabaseCreate("notes"), {
      wrapper: StrictMode,
    });

    let created!: Promise<Row | null>;
    act(() => {
      created = result.current.create({ body: "strict" });
    });
    expect(result.current.loading).toBe(true);

    await act(async () => sent("POST")[0]?.respond({ id: 5 }, 201));
    await created;
    expect(result.current).toMatchObject({ data: { id: 5 }, loading: false });
  });
});
