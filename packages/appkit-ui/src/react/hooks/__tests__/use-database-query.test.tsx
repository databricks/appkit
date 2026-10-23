import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  flush,
  mockDatabaseFetch,
  type PendingRequest,
  publishOperations,
  resetDatabaseTestEnvironment,
} from "@/js/database/test-utils";

import {
  type UseDatabaseQueryOptions,
  type UseDatabaseQueryResult,
  useDatabaseQuery as typedUseDatabaseQuery,
} from "../use-database-query";

// This package has no generated registry, so every operation name is `never`
// here. The typed surface is compiled in use-database.types.test.ts.
const useDatabaseQuery = typedUseDatabaseQuery as unknown as (
  name: string,
  input: unknown,
  options?: UseDatabaseQueryOptions,
) => UseDatabaseQueryResult<unknown>;

let server: ReturnType<typeof mockDatabaseFetch>;

beforeEach(() => {
  server = mockDatabaseFetch();
  publishOperations({ "notes.get": "GET", "notes.create": "POST" });
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

/** Render a query and keep every result it rendered. */
function renderQuery(
  initial: { input: unknown; enabled?: boolean; name?: string } = {
    input: { id: 1 },
  },
) {
  const renders: UseDatabaseQueryResult<unknown>[] = [];
  const hook = renderHook(
    ({ name = "notes.get", input, enabled }) => {
      const result = useDatabaseQuery(name, input, { enabled });
      renders.push(result);
      return result;
    },
    { initialProps: initial },
  );
  return { ...hook, renders };
}

describe("useDatabaseQuery", () => {
  test("reads on mount and moves from loading to the answer", async () => {
    const { result } = renderQuery();

    expect(result.current).toMatchObject({
      data: undefined,
      isLoading: true,
      error: null,
    });
    expect(server.requests).toHaveLength(1);
    expect(server.request(0)).toMatchObject({
      method: "GET",
      input: { id: 1 },
    });

    await answer(server.request(0), { id: 1, body: "hi" });
    expect(result.current).toMatchObject({
      data: { id: 1, body: "hi" },
      isLoading: false,
      error: null,
    });
  });

  test("an equal input with a new identity keeps its one request", async () => {
    const { rerender } = renderQuery();
    rerender({ input: { id: 1 } });
    rerender({ input: { id: 1 } });

    expect(server.requests).toHaveLength(1);
  });

  test("a new input aborts the previous request and never shows its answer", async () => {
    const { result, rerender, renders } = renderQuery();
    await answer(server.request(0), { id: 1 });

    const before = renders.length;
    rerender({ input: { id: 2 } });
    // The render that takes the new input already drops the old answer.
    expect(renders[before]).toMatchObject({
      data: undefined,
      isLoading: true,
      error: null,
    });

    rerender({ input: { id: 3 } });
    expect(server.request(1).signal?.aborted).toBe(true);
    await answer(server.request(1), { id: 2 });
    expect(
      renders.slice(before).map((render) => render.data),
    ).not.toContainEqual({ id: 2 });

    await answer(server.request(2), { id: 3 });
    expect(result.current).toMatchObject({ data: { id: 3 }, isLoading: false });
  });

  test("a failure clears the data, and a new input clears the error", async () => {
    const { result, rerender, renders } = renderQuery();
    await answer(server.request(0), { id: 1 });
    act(() => result.current.refetch());

    await answer(
      server.request(1),
      { error: "Database record not found" },
      { status: 404 },
    );
    expect(result.current).toMatchObject({
      data: undefined,
      isLoading: false,
      error: { code: "NOT_FOUND", status: 404 },
    });

    const before = renders.length;
    rerender({ input: { id: 2 } });
    expect(renders[before]).toMatchObject({ error: null, isLoading: true });
  });

  test("refetch keeps the answer visible while it reloads and aborts the request in flight", async () => {
    const { result } = renderQuery();
    await answer(server.request(0), { id: 1, body: "old" });

    act(() => result.current.refetch());
    expect(result.current).toMatchObject({
      data: { id: 1, body: "old" },
      isLoading: true,
    });
    act(() => result.current.refetch());
    expect(server.request(1).signal?.aborted).toBe(true);

    await answer(server.request(1), { id: 1, body: "superseded" });
    expect(result.current.data).toEqual({ id: 1, body: "old" });
    await answer(server.request(2), { id: 1, body: "new" });
    expect(result.current).toMatchObject({
      data: { id: 1, body: "new" },
      isLoading: false,
    });
  });

  test("enabled: false sends nothing until it is enabled", async () => {
    const { result, rerender } = renderQuery({
      input: { id: 1 },
      enabled: false,
    });

    expect(result.current).toMatchObject({
      data: undefined,
      isLoading: false,
      error: null,
    });
    act(() => result.current.refetch());
    expect(server.requests).toHaveLength(0);

    rerender({ input: { id: 1 }, enabled: true });
    expect(server.requests).toHaveLength(1);
  });

  test("re-enabling a query never shows its earlier answer as settled", async () => {
    const { rerender, renders } = renderQuery({ input: { id: 1 } });
    await answer(server.request(0), { id: 1 });
    rerender({ input: { id: 1 }, enabled: false });

    renders.length = 0;
    rerender({ input: { id: 1 }, enabled: true });
    expect(server.requests).toHaveLength(2);
    expect(renders).not.toContainEqual(
      expect.objectContaining({ data: { id: 1 }, isLoading: false }),
    );
    await answer(server.request(1), { id: 1, again: true });
    expect(renders.at(-1)).toMatchObject({
      data: { id: 1, again: true },
      isLoading: false,
    });
  });

  test.each([
    ["an unpublished name", "boards.get", "is not exposed"],
    ["a write operation", "notes.create", "is not a query"],
  ])(
    "%s reports NOT_EXPOSED and is never sent",
    async (_case, name, reason) => {
      const { result, rerender } = renderQuery({ name, input: { id: 1 } });
      const first = result.current.error;
      rerender({ name, input: { id: 1 } });
      act(() => result.current.refetch());
      await act(flush);

      expect(result.current).toMatchObject({
        data: undefined,
        isLoading: false,
        error: {
          code: "NOT_EXPOSED",
          message: expect.stringContaining(reason),
        },
      });
      expect(result.current.error).toBe(first);
      expect(server.fetchMock).not.toHaveBeenCalled();
    },
  );

  test("an input that cannot be sent reports INVALID_REQUEST without a request", () => {
    const { result } = renderQuery({ input: { id: Number.NaN } });

    expect(result.current).toMatchObject({
      isLoading: false,
      error: { code: "INVALID_REQUEST", status: null },
    });
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  test("unmounting aborts the request", () => {
    const { unmount } = renderQuery();
    unmount();

    expect(server.request(0).signal?.aborted).toBe(true);
  });

  test("hooks with the same input do not share a request", async () => {
    const first = renderQuery();
    const second = renderQuery();
    expect(server.requests).toHaveLength(2);

    await answer(server.request(1), { id: 1, from: "second" });
    expect(second.result.current.data).toEqual({ id: 1, from: "second" });
    expect(first.result.current).toMatchObject({
      data: undefined,
      isLoading: true,
    });
  });

  describe("session changes", () => {
    test("when another query reveals a new actor, this one drops the old actor's data and asks again", async () => {
      const notes = renderQuery({ input: { id: 1 } });
      const other = renderQuery({ input: { id: 2 } });
      await answer(server.request(0), { id: 1, owner: "a" });
      await answer(server.request(1), { id: 2, owner: "a" });

      // Both hooks restart; the first one's reply is still on the way.
      act(() => notes.result.current.refetch());
      act(() => other.result.current.refetch());
      const before = notes.renders.length;
      await answer(
        server.request(3),
        { id: 2, owner: "b" },
        { actor: "actor-b" },
      );

      expect(notes.result.current).toMatchObject({
        data: undefined,
        isLoading: true,
      });
      expect(server.request(2).signal?.aborted).toBe(true);
      await answer(
        server.request(2),
        { id: 1, owner: "a" },
        { actor: "actor-a" },
      );

      // The session change restarted the first hook with its own request.
      const restarts = server.requests
        .slice(4)
        .filter((request) => (request.input as { id: number }).id === 1);
      expect(restarts).toHaveLength(1);
      await answer(
        restarts[0] as PendingRequest,
        { id: 1, owner: "b" },
        {
          actor: "actor-b",
        },
      );
      expect(notes.result.current).toMatchObject({
        data: { id: 1, owner: "b" },
        isLoading: false,
      });
      expect(
        notes.renders.slice(before).map((render) => render.data),
      ).not.toContainEqual({ id: 1, owner: "a" });
    });

    test("a 401 clears every query, which then report UNAUTHENTICATED", async () => {
      const notes = renderQuery({ input: { id: 1 } });
      const other = renderQuery({ input: { id: 2 } });
      await answer(server.request(0), { id: 1 });
      await answer(server.request(1), { id: 2 });

      act(() => other.result.current.refetch());
      await answer(server.request(2), { error: "Sign in" }, { status: 401 });
      expect(notes.result.current.data).toBeUndefined();
      expect(other.result.current.data).toBeUndefined();

      // Each query asks once more in the new session; neither loops.
      for (const request of server.requests.slice(3)) {
        await answer(request, { error: "Sign in" }, { status: 401 });
      }
      await act(flush);
      expect(server.requests).toHaveLength(5);
      for (const hook of [notes, other]) {
        expect(hook.result.current).toMatchObject({
          data: undefined,
          isLoading: false,
          error: { code: "UNAUTHENTICATED", status: 401 },
        });
      }
    });
  });
});
