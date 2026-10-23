import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  flush,
  mockDatabaseFetch,
  operationPath,
  type PendingRequest,
  publishOperations,
  resetDatabaseTestEnvironment,
} from "@/js/database/test-utils";

import {
  type DatabaseMutationOutcome,
  type UseDatabaseMutationResult,
  useDatabaseMutation as typedUseDatabaseMutation,
} from "../use-database-mutation";
import {
  type UseDatabaseQueryResult,
  useDatabaseQuery as typedUseDatabaseQuery,
} from "../use-database-query";

// This package has no generated registry, so every operation name is `never`
// here. The typed surface is compiled in use-database.types.test.ts.
const useDatabaseMutation = typedUseDatabaseMutation as unknown as (
  name: string,
) => UseDatabaseMutationResult<unknown, unknown>;
const useDatabaseQuery = typedUseDatabaseQuery as unknown as (
  name: string,
  input: unknown,
) => UseDatabaseQueryResult<unknown>;

type Outcome = DatabaseMutationOutcome<unknown>;

let server: ReturnType<typeof mockDatabaseFetch>;

beforeEach(() => {
  server = mockDatabaseFetch();
  publishOperations({
    "notes.get": "GET",
    "notes.create": "POST",
    "notes.delete": "DELETE",
  });
});

// This project runs without vitest globals, so nothing unmounts on its own.
afterEach(() => {
  cleanup();
  resetDatabaseTestEnvironment();
});

async function answer(
  request: PendingRequest,
  body: unknown,
  options?: Parameters<PendingRequest["respond"]>[1],
): Promise<void> {
  await act(async () => {
    request.respond(body, options);
    await flush();
  });
}

/** Start one call inside `act` and hand back its pending outcome. */
function start(
  hook: { current: UseDatabaseMutationResult<unknown, unknown> },
  input: unknown,
): Promise<Outcome> {
  let outcome!: Promise<Outcome>;
  act(() => {
    outcome = hook.current.mutate(input);
  });
  return outcome;
}

describe("useDatabaseMutation", () => {
  test("mounting sends nothing; mutate sends the write once and resolves its outcome", async () => {
    const { result, rerender } = renderHook(() =>
      useDatabaseMutation("notes.create"),
    );
    rerender();
    await act(flush);
    expect(server.fetchMock).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      data: undefined,
      isLoading: false,
      error: null,
    });

    const outcome = start(result, { body: "hi" });
    expect(result.current.isLoading).toBe(true);
    expect(server.requests).toHaveLength(1);
    expect(server.request(0)).toMatchObject({
      url: operationPath("notes.create"),
      method: "POST",
      body: '{"body":"hi"}',
      signal: undefined,
    });

    await answer(server.request(0), { id: 7, body: "hi" }, { status: 201 });
    await expect(outcome).resolves.toEqual({
      data: { id: 7, body: "hi" },
      error: null,
    });
    expect(result.current).toMatchObject({
      data: { id: 7, body: "hi" },
      isLoading: false,
      error: null,
    });
  });

  test("a delete that answers 204 succeeds with no data", async () => {
    const { result } = renderHook(() => useDatabaseMutation("notes.delete"));
    const outcome = start(result, { id: 7 });

    expect(server.request(0)).toMatchObject({
      method: "DELETE",
      body: '{"id":7}',
    });
    await answer(server.request(0), undefined, { status: 204 });
    await expect(outcome).resolves.toEqual({ data: undefined, error: null });
  });

  test.each([
    [
      "an error reply",
      (request: PendingRequest) =>
        request.respond({ error: "Busy" }, { status: 503 }),
      "TRANSIENT",
    ],
    [
      "no reply",
      (request: PendingRequest) =>
        request.fail(new TypeError("Failed to fetch")),
      "OUTCOME_UNKNOWN",
    ],
  ])(
    "%s resolves the failure, lands in error, and is never retried",
    async (_case, fail, code) => {
      const { result } = renderHook(() => useDatabaseMutation("notes.create"));
      const outcome = start(result, { body: "hi" });

      await act(async () => {
        fail(server.request(0));
        await flush();
      });
      await expect(outcome).resolves.toMatchObject({
        data: undefined,
        error: { code },
      });
      expect(result.current).toMatchObject({
        data: undefined,
        isLoading: false,
        error: { code },
      });
      await act(flush);
      expect(server.fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test("a read operation is never sent as a mutation", async () => {
    const { result } = renderHook(() => useDatabaseMutation("notes.get"));
    const outcome = await act(() => result.current.mutate({ id: 1 }));

    expect(outcome).toMatchObject({
      data: undefined,
      error: {
        code: "NOT_EXPOSED",
        message: expect.stringContaining("is not a mutation"),
      },
    });
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  test("only the latest call reports in state; every call resolves its own outcome", async () => {
    const { result } = renderHook(() => useDatabaseMutation("notes.create"));
    const first = start(result, { body: "first" });
    const second = start(result, { body: "second" });

    await answer(server.request(1), { id: 2 });
    await answer(server.request(0), { id: 1 });

    await expect(first).resolves.toEqual({ data: { id: 1 }, error: null });
    await expect(second).resolves.toEqual({ data: { id: 2 }, error: null });
    expect(result.current.data).toEqual({ id: 2 });
  });

  test("reset returns to idle, and a call in flight no longer reports", async () => {
    const { result } = renderHook(() => useDatabaseMutation("notes.create"));
    const outcome = start(result, { body: "hi" });
    act(() => result.current.reset());

    expect(result.current).toMatchObject({ data: undefined, isLoading: false });
    await answer(server.request(0), { id: 7 });
    await expect(outcome).resolves.toEqual({ data: { id: 7 }, error: null });
    expect(result.current).toMatchObject({ data: undefined, isLoading: false });
  });

  test("unmounting does not abort a write in flight", async () => {
    const { result, unmount } = renderHook(() =>
      useDatabaseMutation("notes.create"),
    );
    const outcome = start(result, { body: "hi" });
    unmount();

    expect(server.request(0).signal).toBeUndefined();
    await answer(server.request(0), { id: 7 });
    await expect(outcome).resolves.toEqual({ data: { id: 7 }, error: null });
  });

  test("a successful write restarts mounted queries, keeping their data while they reload", async () => {
    const { result } = renderHook(() => ({
      note: useDatabaseQuery("notes.get", { id: 1 }),
      create: useDatabaseMutation("notes.create"),
    }));
    await answer(server.request(0), { id: 1, count: 1 });

    const failed = start({ current: result.current.create }, { body: "x" });
    await answer(server.request(1), { error: "Invalid" }, { status: 422 });
    await failed;
    expect(server.requests).toHaveLength(2);

    const created = start({ current: result.current.create }, { body: "y" });
    await answer(server.request(2), { id: 2 });
    await created;
    expect(server.requests).toHaveLength(4);
    expect(server.request(3).input).toEqual({ id: 1 });
    expect(result.current.note).toMatchObject({
      data: { id: 1, count: 1 },
      isLoading: true,
    });

    await answer(server.request(3), { id: 1, count: 2 });
    expect(result.current.note).toMatchObject({
      data: { id: 1, count: 2 },
      isLoading: false,
    });
  });

  test("a write whose outcome is unknown reports it and restarts mounted queries", async () => {
    const { result } = renderHook(() => ({
      note: useDatabaseQuery("notes.get", { id: 1 }),
      create: useDatabaseMutation("notes.create"),
    }));
    await answer(server.request(0), { id: 1, count: 1 });

    const outcome = start({ current: result.current.create }, { body: "x" });
    await answer(
      server.request(1),
      { error: "Database write may have completed", outcome: "unknown" },
      { status: 500 },
    );

    await expect(outcome).resolves.toMatchObject({
      data: undefined,
      error: { code: "OUTCOME_UNKNOWN", status: 500 },
    });
    expect(result.current.create.error).toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(server.requests).toHaveLength(3);
    expect(server.request(2).input).toEqual({ id: 1 });
  });

  test("a write answered 401 after an authenticated read shows UNAUTHENTICATED", async () => {
    const { result } = renderHook(() => ({
      note: useDatabaseQuery("notes.get", { id: 1 }),
      create: useDatabaseMutation("notes.create"),
    }));
    await answer(server.request(0), { id: 1 });

    const outcome = start({ current: result.current.create }, { body: "x" });
    await answer(
      server.request(1),
      { error: "Authentication required" },
      { status: 401, actor: null },
    );

    await expect(outcome).resolves.toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
    expect(result.current.create).toMatchObject({
      data: undefined,
      isLoading: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });

  test("a write answered after the session changed reports SESSION_CHANGED and shows nothing", async () => {
    const { result } = renderHook(() => ({
      note: useDatabaseQuery("notes.get", { id: 1 }),
      create: useDatabaseMutation("notes.create"),
    }));
    await answer(server.request(0), { id: 1 });

    const outcome = start({ current: result.current.create }, { body: "hi" });
    act(() => result.current.note.refetch());
    await answer(server.request(2), { id: 1 }, { actor: "actor-b" });
    expect(result.current.create).toMatchObject({
      data: undefined,
      isLoading: false,
      error: null,
    });

    const sent = server.requests.length;
    await answer(server.request(1), { id: 9 }, { actor: "actor-a" });
    await expect(outcome).resolves.toMatchObject({
      data: undefined,
      error: { code: "SESSION_CHANGED" },
    });
    expect(result.current.create).toMatchObject({
      data: undefined,
      isLoading: false,
      error: null,
    });
    expect(server.requests).toHaveLength(sent);
  });
});
