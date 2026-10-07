import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DatabaseApiError } from "@/js/database/errors";

import {
  invalidateDatabaseReads,
  mockDatabaseFetch,
  nextTick,
  page,
  publishDatabase,
  resetDatabaseTestEnvironment,
  type Row,
  useDatabaseCreate,
  useDatabaseDelete,
  useDatabaseList,
  useDatabaseUpdate,
} from "./database-test-utils";

const ENDPOINTS = {
  "notes.list": "/api/database/notes",
  "notes.create": "/api/database/notes",
  "notes.update": "/api/database/notes/:id",
  "notes.delete": "/api/database/notes/:id",
  "boards.list": "/api/database/boards",
  "note_events.list": "/api/database/note_events",
};

// As `DatabasePlugin` publishes them: board → notes → note_events.
const RELATIONS = {
  boards: { notes: "notes" },
  notes: { boards: "boards", note_events: "note_events" },
  note_events: { notes: "notes" },
};

describe("database write hooks", () => {
  let fetchMock: ReturnType<typeof mockDatabaseFetch>["fetchMock"];
  let sent: ReturnType<typeof mockDatabaseFetch>["sent"];

  /** URLs of the reads sent after the first `after`. */
  const readsAfter = (after: number) =>
    sent("GET")
      .slice(after)
      .map((request) => request.url);

  /** Answer every read still open, as the server would. */
  const answerReads = (from: number, body: unknown = page({ id: 1 })) => {
    for (const request of sent("GET").slice(from)) request.respond(body);
  };

  beforeEach(() => {
    ({ fetchMock, sent } = mockDatabaseFetch());
    publishDatabase(ENDPOINTS, RELATIONS);
  });

  afterEach(resetDatabaseTestEnvironment);

  /** Mount a notes read and a boards read, and answer both. */
  async function mountReads() {
    const reads = renderHook(() => ({
      notes: useDatabaseList("notes"),
      boards: useDatabaseList("boards"),
    }));
    await act(async () => answerReads(0));
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

  test("rejects a non-finite update before sending it or invalidating reads", async () => {
    const { result } = renderHook(() => useDatabaseUpdate("notes"));
    let updated!: Row | null;
    await act(async () => {
      updated = await result.current.update(7, { rank: NaN });
    });
    expect(updated).toBeNull();
    expect(result.current.error).toMatchObject({
      code: "INVALID_REQUEST",
      status: null,
      message:
        "Database write numbers must be finite; use null explicitly to clear a value",
    });
    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
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

  test("refuses a write addressed by an unaddressable id, without a request", async () => {
    const { result } = renderHook(() => useDatabaseDelete("notes"));

    let removed!: Promise<boolean>;
    await act(async () => {
      removed = result.current.remove("..");
      await removed;
    });

    await expect(removed).resolves.toBe(false);
    expect(result.current.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a successful write restarts every mounted read by default and resolves once they reload", async () => {
    const reads = await mountReads();
    const writer = renderHook(() => useDatabaseCreate("notes"));
    expect(sent("GET")).toHaveLength(2);

    let created!: Promise<Row | null>;
    let settled = false;
    act(() => {
      created = writer.result.current.create({ body: "new" });
      void created.then(() => {
        settled = true;
      });
    });
    await act(async () => sent("POST")[0]?.respond({ id: 2 }, 201));

    expect(readsAfter(2)).toEqual([
      "/api/database/notes",
      "/api/database/boards",
    ]);
    // Reads keep their data while they reload; the write waits for them.
    expect(reads.result.current.notes).toMatchObject({
      data: page({ id: 1 }),
      loading: true,
    });
    expect(writer.result.current).toMatchObject({ loading: true, data: null });
    expect(settled).toBe(false);

    await act(async () => {
      sent("GET")[2]?.respond(page({ id: 1 }, { id: 2 }));
      sent("GET")[3]?.respond(page({ id: 1 }));
    });
    await expect(created).resolves.toEqual({ id: 2 });
    expect(reads.result.current.notes.data).toEqual(page({ id: 1 }, { id: 2 }));
    expect(writer.result.current).toMatchObject({
      loading: false,
      data: { id: 2 },
    });
  });

  test("overlapping writes wait for the latest reload of every read before resolving or onSuccess", async () => {
    const reads = await mountReads();
    const createdSuccess = vi.fn();
    const updatedSuccess = vi.fn();
    const creator = renderHook(() =>
      useDatabaseCreate("notes", { onSuccess: createdSuccess }),
    );
    const updater = renderHook(() =>
      useDatabaseUpdate("notes", { onSuccess: updatedSuccess }),
    );
    const settled: string[] = [];
    let created!: Promise<Row | null>;
    let updated!: Promise<Row | null>;
    act(() => {
      created = creator.result.current.create({ body: "new" });
      void created.then(() => {
        settled.push("create");
      });
    });
    await act(async () =>
      sent("POST")[0]?.respond({ id: 2, body: "new" }, 201),
    );
    await act(async () => sent("GET")[2]?.respond(page({ id: 1 }, { id: 2 })));
    expect(settled).toEqual([]);

    act(() => {
      updated = updater.result.current.update(1, { body: "edited" });
      void updated.then(() => {
        settled.push("update");
      });
    });
    await act(async () => {
      sent("PATCH")[0]?.respond({ id: 1, body: "edited" });
      await nextTick();
    });
    expect(sent("GET")[3]?.signal?.aborted).toBe(true);
    expect(sent("GET")).toHaveLength(6);
    expect(settled).toEqual([]);
    expect(createdSuccess).not.toHaveBeenCalled();
    expect(creator.result.current.loading).toBe(true);
    expect(updater.result.current.loading).toBe(true);

    await act(async () => {
      sent("GET")[5]?.respond(page({ id: "current board" }));
      sent("GET")[3]?.respond(page({ id: "stale board" }));
      await nextTick();
    });
    expect(settled).toEqual([]);
    expect(createdSuccess).not.toHaveBeenCalled();
    expect(updatedSuccess).not.toHaveBeenCalled();

    const freshNotes = page({ id: 1, body: "edited" }, { id: 2, body: "new" });
    await act(async () => sent("GET")[4]?.respond(freshNotes));
    await expect(Promise.all([created, updated])).resolves.toEqual([
      { id: 2, body: "new" },
      { id: 1, body: "edited" },
    ]);
    expect(reads.result.current.notes.data).toEqual(freshNotes);
    expect(reads.result.current.boards.data).toEqual(
      page({ id: "current board" }),
    );
    expect(createdSuccess).toHaveBeenCalledOnce();
    expect(updatedSuccess).toHaveBeenCalledOnce();
    expect(creator.result.current.loading).toBe(false);
    expect(updater.result.current.loading).toBe(false);
  });

  test("a restarted read that fails still lets the write resolve", async () => {
    await mountReads();
    const writer = renderHook(() => useDatabaseCreate("notes"));

    let created!: Promise<Row | null>;
    act(() => {
      created = writer.result.current.create({ body: "new" });
    });
    await act(async () => sent("POST")[0]?.respond({ id: 2 }, 201));
    await act(async () => answerReads(2, { error: "down" }));

    await expect(created).resolves.toEqual({ id: 2 });
    expect(writer.result.current.error).toBeNull();
  });

  test("invalidate narrows the restart to reads of the named tables, or turns it off", async () => {
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
    expect(readsAfter(2)).toEqual(["/api/database/notes"]);
    await act(async () => answerReads(2));
    await created;

    act(() => {
      created = writers.result.current.none.create({ body: "b" });
    });
    await act(async () => sent("POST")[1]?.respond({ id: 3 }, 201));
    await created;
    expect(sent("GET")).toHaveLength(3);
  });

  test("a narrowed invalidate reaches the reads whose includes show the written table", async () => {
    renderHook(() => ({
      // boards → notes, and boards → notes → note_events.
      boards: useDatabaseList("boards", { include: { notes: { limit: 5 } } }),
      timeline: useDatabaseList("boards", {
        include: { notes: { include: { note_events: { limit: 5 } } } },
      }),
      plain: useDatabaseList("boards"),
      events: useDatabaseList("note_events"),
    }));
    await act(async () => answerReads(0));

    act(() => {
      void invalidateDatabaseReads(["notes"]);
    });
    expect(readsAfter(4)).toEqual([
      "/api/database/boards?include=%7B%22notes%22%3A%7B%22limit%22%3A5%7D%7D",
      expect.stringContaining("note_events"),
    ]);

    act(() => {
      void invalidateDatabaseReads(["note_events"]);
    });
    expect(readsAfter(6)).toEqual([
      expect.stringContaining("note_events"),
      "/api/database/note_events",
    ]);
  });

  test("a read with an include the server did not describe restarts on any scoped invalidate", async () => {
    renderHook(() => ({
      unknown: useDatabaseList("boards", { include: { archived: true } }),
      plain: useDatabaseList("boards"),
    }));
    await act(async () => answerReads(0));

    act(() => {
      void invalidateDatabaseReads(["note_events"]);
    });
    expect(readsAfter(2)).toEqual([
      "/api/database/boards?include=%7B%22archived%22%3Atrue%7D",
    ]);
  });

  test("invalidateDatabaseReads refreshes reads after a write the hooks did not make", async () => {
    await mountReads();

    // A custom route or a databaseApi call changed boards rows.
    let refreshed!: Promise<void>;
    let done = false;
    act(() => {
      refreshed = invalidateDatabaseReads(["boards"]).then(() => {
        done = true;
      });
    });
    expect(readsAfter(2)).toEqual(["/api/database/boards"]);
    await Promise.resolve();
    expect(done).toBe(false);
    await act(async () => answerReads(2));
    await refreshed;
    expect(done).toBe(true);

    // With no scope, every mounted read restarts.
    act(() => {
      void invalidateDatabaseReads();
    });
    expect(readsAfter(3)).toEqual([
      "/api/database/notes",
      "/api/database/boards",
    ]);

    await expect(invalidateDatabaseReads(false)).resolves.toBeUndefined();
    await expect(invalidateDatabaseReads([])).resolves.toBeUndefined();
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
    const onSuccess = vi.fn();
    const writer = renderHook(() => useDatabaseCreate("notes", { onSuccess }));

    let created!: Promise<Row | null>;
    act(() => {
      created = writer.result.current.create({ body: "late" });
    });
    writer.unmount();

    // The write carries no abort signal: cancelling it would not undo it.
    expect(sent("POST")[0]?.signal).toBeUndefined();
    await act(async () => sent("POST")[0]?.respond({ id: 9 }, 201));
    expect(sent("GET")).toHaveLength(4);
    await act(async () => answerReads(2));

    await expect(created).resolves.toEqual({ id: 9 });
    // The rows changed, so the callback runs even though the hook is gone.
    expect(onSuccess).toHaveBeenCalledWith({ id: 9 }, { body: "late" });
  });

  test("onSuccess and onError run for every call with its arguments, after the state settles", async () => {
    const events: string[] = [];
    const { result } = renderHook(() => {
      const hook = useDatabaseUpdate("notes", {
        onSuccess: (row, id, values) =>
          events.push(`ok ${JSON.stringify([row, id, values])}`),
        onError: (error, id) =>
          events.push(`fail ${error.code} ${String(id)} ${hook.loading}`),
      });
      return hook;
    });

    let first!: Promise<Row | null>;
    let second!: Promise<Row | null>;
    act(() => {
      first = result.current.update(1, { body: "a" });
      second = result.current.update(2, { body: "b" });
    });
    await act(async () => {
      sent("PATCH")[0]?.respond({ id: 1 });
      sent("PATCH")[1]?.respond({ error: "Database conflict" }, 409);
    });
    await Promise.all([first, second]);

    // The stale first call does not update the state, but is still reported.
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^fail CONFLICT 2 /),
        `ok ${JSON.stringify([{ id: 1 }, 1, { body: "a" }])}`,
      ]),
    );
    expect(result.current.error).toMatchObject({ code: "CONFLICT" });
  });

  test("a delete reports the removed id to onSuccess", async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useDatabaseDelete("notes", { onSuccess }),
    );

    let removed!: Promise<boolean>;
    act(() => {
      removed = result.current.remove(7);
    });
    await act(async () => sent("DELETE")[0]?.respond(null, 204));

    await expect(removed).resolves.toBe(true);
    expect(onSuccess).toHaveBeenCalledWith(7);
  });

  test("a throwing callback is reported as uncaught without breaking the call", async () => {
    const reported = vi.fn();
    vi.stubGlobal("reportError", reported);
    const { result } = renderHook(() =>
      useDatabaseCreate("notes", {
        onSuccess: () => {
          throw new Error("callback bug");
        },
      }),
    );

    let created!: Promise<Row | null>;
    act(() => {
      created = result.current.create({ body: "x" });
    });
    await act(async () => sent("POST")[0]?.respond({ id: 1 }, 201));

    await expect(created).resolves.toEqual({ id: 1 });
    expect(reported).toHaveBeenCalledWith(new Error("callback bug"));
    expect(result.current).toMatchObject({ data: { id: 1 }, error: null });
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

  test("keeps its write functions stable across renders with inline options", () => {
    const { result, rerender } = renderHook(() => ({
      create: useDatabaseCreate("notes", {
        invalidate: ["notes", "boards"],
        onSuccess: () => {},
      }),
      remove: useDatabaseDelete("notes", { onError: () => {} }),
    }));
    const { create } = result.current.create;
    const { remove, reset } = result.current.remove;

    rerender();

    expect(result.current.create.create).toBe(create);
    expect(result.current.remove.remove).toBe(remove);
    expect(result.current.remove.reset).toBe(reset);
  });

  test("uses the options of the latest render when a call settles", async () => {
    await mountReads();
    const { result, rerender } = renderHook(
      ({ scope }: { scope: readonly string[] }) =>
        useDatabaseCreate("notes", { invalidate: scope }),
      { initialProps: { scope: ["notes"] as readonly string[] } },
    );

    let created!: Promise<Row | null>;
    act(() => {
      created = result.current.create({ body: "x" });
    });
    rerender({ scope: ["boards"] });
    await act(async () => sent("POST")[0]?.respond({ id: 1 }, 201));

    expect(readsAfter(2)).toEqual(["/api/database/boards"]);
    await act(async () => answerReads(2));
    await created;
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
