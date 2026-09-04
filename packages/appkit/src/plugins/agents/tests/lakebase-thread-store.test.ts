import type { Pool, QueryResult } from "pg";
import type { Message, ToolCall } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createLakebasePool: vi.fn() }));

vi.mock("../../../connectors/lakebase", () => ({
  createLakebasePool: mocks.createLakebasePool,
}));

import { LakebaseThreadStore } from "../lakebase-thread-store";

const USER = "user-a";
const OTHER = "user-b";

/** Build a full-shape QueryResult so mock returns satisfy pg's type. */
function qr(
  rows: Record<string, unknown>[] = [],
  rowCount = rows.length,
): QueryResult {
  return { rows, rowCount, command: "", oid: 0, fields: [] } as QueryResult;
}

/** A pool whose `query` returns empty by default; program per-call as needed. */
function makePool() {
  const query = vi.fn(async () => qr());
  const end = vi.fn(async () => undefined);
  const pool = { query, end } as unknown as Pool;
  return { pool, query, end };
}

/** Collapse whitespace so SQL assertions aren't formatting-coupled. */
const sql = (call: unknown[]) => String(call[0]).replace(/\s+/g, " ").trim();
const params = (call: unknown[]) => call[1] as unknown[];

beforeEach(() => {
  mocks.createLakebasePool.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("LakebaseThreadStore construction & pool ownership", () => {
  test("creates its own pool when none is injected", () => {
    const { pool } = makePool();
    mocks.createLakebasePool.mockReturnValue(pool);
    new LakebaseThreadStore();
    expect(mocks.createLakebasePool).toHaveBeenCalledTimes(1);
  });

  test("uses an injected pool and never calls the factory", () => {
    const { pool } = makePool();
    new LakebaseThreadStore({ pool });
    expect(mocks.createLakebasePool).not.toHaveBeenCalled();
  });

  test("close() ends an owned pool", async () => {
    const { pool, end } = makePool();
    mocks.createLakebasePool.mockReturnValue(pool);
    await new LakebaseThreadStore().close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("close() does NOT end an injected pool", async () => {
    const { pool, end } = makePool();
    await new LakebaseThreadStore({ pool }).close();
    expect(end).not.toHaveBeenCalled();
  });

  test("rejects a non-identifier tableSchema before touching the pool", () => {
    const { pool } = makePool();
    expect(
      () => new LakebaseThreadStore({ pool, tableSchema: "a; drop" }),
    ).toThrow(/invalid tableSchema/);
  });
});

describe("LakebaseThreadStore.init (bootstrap)", () => {
  test("verifies connectivity and creates both tables + indexes, once", async () => {
    const { pool, query } = makePool();
    const store = new LakebaseThreadStore({ pool });

    await store.init();
    const statements = query.mock.calls.map(sql);
    expect(statements[0]).toBe("select 1");
    expect(
      statements.some((s) =>
        s.includes("CREATE TABLE IF NOT EXISTS agent_threads"),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        s.includes("CREATE TABLE IF NOT EXISTS agent_messages"),
      ),
    ).toBe(true);
    expect(statements.some((s) => s.includes("ON DELETE CASCADE"))).toBe(true);
    expect(
      statements.some((s) =>
        s.includes("CREATE INDEX IF NOT EXISTS agent_threads_user_updated_idx"),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        s.includes("CREATE INDEX IF NOT EXISTS agent_messages_thread_seq_idx"),
      ),
    ).toBe(true);

    const afterFirst = query.mock.calls.length;
    await store.init(); // once-guarded: no new DDL
    expect(query.mock.calls.length).toBe(afterFirst);
  });

  test("qualifies tables with a valid tableSchema and creates the schema", async () => {
    const { pool, query } = makePool();
    await new LakebaseThreadStore({ pool, tableSchema: "appkit" }).init();
    const statements = query.mock.calls.map(sql);
    expect(
      statements.some((s) => s.includes("CREATE SCHEMA IF NOT EXISTS appkit")),
    ).toBe(true);
    expect(
      statements.some((s) =>
        s.includes("CREATE TABLE IF NOT EXISTS appkit.agent_threads"),
      ),
    ).toBe(true);
    expect(statements.some((s) => s.includes("appkit.agent_messages"))).toBe(
      true,
    );
  });
});

describe("LakebaseThreadStore.create", () => {
  test("inserts a thread scoped to the user and revives dates", async () => {
    const { pool, query } = makePool();
    const created = "2026-01-02T03:04:05.000Z";
    query.mockResolvedValueOnce(
      qr([
        { id: "t1", user_id: USER, created_at: created, updated_at: created },
      ]),
    );

    const thread = await new LakebaseThreadStore({ pool }).create(USER);

    expect(sql(query.mock.calls[0])).toContain("INSERT INTO agent_threads");
    // A generated uuid, then the user id.
    expect(params(query.mock.calls[0])[1]).toBe(USER);
    expect(thread.messages).toEqual([]);
    expect(thread.createdAt).toBeInstanceOf(Date);
    expect(thread.createdAt.toISOString()).toBe(created);
    expect(thread.userId).toBe(USER);
  });
});

describe("LakebaseThreadStore.get", () => {
  test("returns null and skips the message query when the thread is absent", async () => {
    const { pool, query } = makePool();
    query.mockResolvedValueOnce(qr([]));

    const result = await new LakebaseThreadStore({ pool }).get("missing", USER);

    expect(result).toBeNull();
    expect(query).toHaveBeenCalledTimes(1); // no second (messages) query
  });

  test("scopes both queries to the user, orders messages, and preserves tool_calls verbatim", async () => {
    const { pool, query } = makePool();
    const ts = "2026-02-02T00:00:00.000Z";
    const toolCalls: ToolCall[] = [
      { id: "c1", name: "search", args: { q: "x" }, thoughtSignature: "SIG==" },
    ];
    query
      .mockResolvedValueOnce(
        qr([{ id: "t1", user_id: USER, created_at: ts, updated_at: ts }]),
      )
      .mockResolvedValueOnce(
        qr([
          {
            thread_id: "t1",
            id: "m1",
            role: "assistant",
            content: "hi",
            tool_call_id: "c1",
            tool_calls: toolCalls,
            created_at: ts,
          },
        ]),
      );

    const thread = await new LakebaseThreadStore({ pool }).get("t1", USER);

    // Both queries carry the user_id as the isolation boundary.
    expect(sql(query.mock.calls[0])).toContain(
      "WHERE id = $1 AND user_id = $2",
    );
    expect(params(query.mock.calls[0])).toEqual(["t1", USER]);
    expect(sql(query.mock.calls[1])).toContain(
      "WHERE thread_id = $1 AND user_id = $2",
    );
    expect(sql(query.mock.calls[1])).toContain("ORDER BY seq");
    expect(params(query.mock.calls[1])).toEqual(["t1", USER]);

    expect(thread).not.toBeNull();
    const msg = thread?.messages[0];
    expect(msg?.createdAt).toBeInstanceOf(Date);
    expect(msg?.toolCallId).toBe("c1");
    // thoughtSignature survives the jsonb round trip untouched.
    expect(msg?.toolCalls).toEqual(toolCalls);
    expect(msg?.toolCalls?.[0].thoughtSignature).toBe("SIG==");
  });
});

describe("LakebaseThreadStore.list", () => {
  test("returns [] without a message query when the user has no threads", async () => {
    const { pool, query } = makePool();
    query.mockResolvedValueOnce(qr([]));

    const result = await new LakebaseThreadStore({ pool }).list(USER);

    expect(result).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("groups messages by thread in one query and leaves empty threads empty", async () => {
    const { pool, query } = makePool();
    const ts = "2026-03-03T00:00:00.000Z";
    query
      .mockResolvedValueOnce(
        qr([
          { id: "t1", user_id: USER, created_at: ts, updated_at: ts },
          { id: "t2", user_id: USER, created_at: ts, updated_at: ts },
        ]),
      )
      .mockResolvedValueOnce(
        qr([
          {
            thread_id: "t1",
            id: "m1",
            role: "user",
            content: "a",
            tool_call_id: null,
            tool_calls: null,
            created_at: ts,
          },
          {
            thread_id: "t1",
            id: "m2",
            role: "assistant",
            content: "b",
            tool_call_id: null,
            tool_calls: null,
            created_at: ts,
          },
        ]),
      );

    const threads = await new LakebaseThreadStore({ pool }).list(USER);

    expect(sql(query.mock.calls[0])).toContain("WHERE user_id = $1");
    expect(sql(query.mock.calls[0])).toContain("ORDER BY updated_at DESC");
    expect(params(query.mock.calls[0])).toEqual([USER]);
    expect(params(query.mock.calls[1])).toEqual([USER]);
    expect(query).toHaveBeenCalledTimes(2); // no N+1
    expect(threads[0].messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(threads[1].messages).toEqual([]);
  });
});

describe("LakebaseThreadStore.addMessage", () => {
  const message: Message = {
    id: "m1",
    role: "user",
    content: "hello",
    createdAt: new Date(),
  };

  test("writes the message + bumps updated_at in one user-scoped statement", async () => {
    const { pool, query } = makePool();
    query.mockResolvedValueOnce(qr([], 1));

    await new LakebaseThreadStore({ pool }).addMessage("t1", USER, message);

    const call = query.mock.calls[0];
    expect(sql(call)).toContain("UPDATE agent_threads SET updated_at = now()");
    expect(sql(call)).toContain("WHERE id = $1 AND user_id = $2");
    expect(sql(call)).toContain("INSERT INTO agent_messages");
    const p = params(call);
    expect(p[0]).toBe("t1");
    expect(p[1]).toBe(USER);
    expect(p[5]).toBeNull(); // tool_call_id absent
    expect(p[6]).toBeNull(); // tool_calls absent
  });

  test("serializes tool_calls to JSON for the jsonb column", async () => {
    const { pool, query } = makePool();
    query.mockResolvedValueOnce(qr([], 1));
    const toolCalls: ToolCall[] = [
      { id: "c1", name: "run", args: {}, thoughtSignature: "Zm9v" },
    ];

    await new LakebaseThreadStore({ pool }).addMessage("t1", USER, {
      ...message,
      toolCallId: "c1",
      toolCalls,
    });

    const p = params(query.mock.calls[0]);
    expect(p[5]).toBe("c1");
    expect(p[6]).toBe(JSON.stringify(toolCalls));
  });

  test("throws when the thread does not exist for the user (0 rows written)", async () => {
    const { pool, query } = makePool();
    query.mockResolvedValueOnce(qr([], 0));

    await expect(
      new LakebaseThreadStore({ pool }).addMessage("nope", OTHER, message),
    ).rejects.toThrow("Thread nope not found");
  });
});

describe("LakebaseThreadStore.delete", () => {
  test("deletes scoped to the user and reports whether a row was removed", async () => {
    const { pool, query } = makePool();
    query.mockResolvedValueOnce(qr([], 1)).mockResolvedValueOnce(qr([], 0));
    const store = new LakebaseThreadStore({ pool });

    expect(await store.delete("t1", USER)).toBe(true);
    expect(await store.delete("t1", OTHER)).toBe(false);
    expect(sql(query.mock.calls[0])).toContain(
      "DELETE FROM agent_threads WHERE id = $1 AND user_id = $2",
    );
    expect(params(query.mock.calls[0])).toEqual(["t1", USER]);
  });
});

describe("LakebaseThreadStore user_id scoping (isolation boundary)", () => {
  test("every CRUD query carries the user id in its params", async () => {
    const { pool, query } = makePool();
    // Enough rows for each method to exercise both queries where applicable.
    query.mockResolvedValue(
      qr([
        {
          id: "t1",
          user_id: USER,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    const store = new LakebaseThreadStore({ pool });

    await store.create(USER);
    await store.get("t1", USER);
    await store.list(USER);
    await store.addMessage("t1", USER, {
      id: "m1",
      role: "user",
      content: "x",
      createdAt: new Date(),
    });
    await store.delete("t1", USER);

    for (const call of query.mock.calls) {
      expect(params(call)).toContain(USER);
    }
  });
});
