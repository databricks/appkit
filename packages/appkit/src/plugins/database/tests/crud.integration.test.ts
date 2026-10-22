import { mockServiceContext } from "@tools/test-helpers";
import type { Request, RequestHandler, Response } from "express";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DataPath, Row } from "../../../database/runtime";
import { defineSchema, id, text } from "../../../database/schema-builder";
import { DatabaseValidationError } from "../../../errors";
import type { ITelemetry } from "../../../telemetry";

const mocks = vi.hoisted(() => ({
  initializeLakebasePool: vi.fn(),
  createDrizzleDb: vi.fn(),
  createDrizzleDataPath: vi.fn(),
}));

vi.mock("../../../connectors/lakebase", () => ({
  initializeLakebasePool: mocks.initializeLakebasePool,
}));
vi.mock("../../../database/runtime/engine/drizzle-data-path", () => ({
  createDrizzleDb: mocks.createDrizzleDb,
  createDrizzleDataPath: mocks.createDrizzleDataPath,
}));
// The catalog comparison has its own suite; this fake answers no catalog.
vi.mock("../schema-check", () => ({
  assertSchemaMatchesDatabase: async () => undefined,
}));

import { DatabasePlugin } from "../database";

const schema = defineSchema((builder) => {
  const notes = builder.table("notes", {
    id: id(),
    body: text().notNull(),
    secret: text().private(),
  });
  const audits = builder.table("audits", {
    id: id(),
    action: text().notNull(),
  });
  return { notes, audits };
});

type Store = Record<string, Row[]>;

/**
 * In-memory DataPath whose transaction stages writes and discards them unless
 * the callback resolves, so a rollback is observable end to end.
 */
function memoryDataPath() {
  const committed: Store = { notes: [], audits: [] };
  const log: string[] = [];
  let nextId = 1;

  const build = (store: Store): DataPath => ({
    select: async (table) => store[table.$name].slice(),
    findOne: async (table, value) =>
      store[table.$name].find((row) => row.id === value) ?? null,
    count: async (table) => store[table.$name].length,
    insert: async (table, values) => {
      const row = { id: nextId++, ...values };
      store[table.$name].push(row);
      log.push(`insert:${table.$name}`);
      return row;
    },
    update: async (table, value, values) => {
      const row = store[table.$name].find((entry) => entry.id === value);
      if (!row) return null;
      Object.assign(row, values);
      log.push(`update:${table.$name}`);
      return { ...row };
    },
    upsert: async (table, values) => {
      const row = { id: nextId++, ...values };
      store[table.$name].push(row);
      return row;
    },
    delete: async (table, value) => {
      const index = store[table.$name].findIndex((row) => row.id === value);
      if (index === -1) return false;
      store[table.$name].splice(index, 1);
      log.push(`delete:${table.$name}`);
      return true;
    },
    raw: async () => [],
    transaction: async (callback) => {
      log.push("begin");
      const staged: Store = Object.fromEntries(
        Object.entries(store).map(([name, rows]) => [
          name,
          rows.map((row) => ({ ...row })),
        ]),
      );
      try {
        const result = await callback(build(staged));
        for (const name of Object.keys(store)) store[name] = staged[name];
        log.push("commit");
        return result;
      } catch (error) {
        log.push("rollback");
        throw error;
      }
    },
  });

  return { path: build(committed), committed, log };
}

function fakeResponse() {
  const sent: { status?: number; body?: string } = {};
  const res = {
    headersSent: false,
    status: (code: number) => {
      sent.status = code;
      return res;
    },
    type: () => res,
    setHeader: () => res,
    send: (body?: string) => {
      sent.body = body;
      return res;
    },
  };
  return {
    res: res as unknown as Response,
    sent,
    json: () => JSON.parse(sent.body ?? "null"),
  };
}

async function mount() {
  const database = memoryDataPath();
  mocks.initializeLakebasePool.mockResolvedValue({
    end: vi.fn(async () => undefined),
  });
  mocks.createDrizzleDb.mockReturnValue({});
  mocks.createDrizzleDataPath.mockReturnValue(database.path);

  const plugin = new DatabasePlugin({
    schema,
  });
  (plugin as unknown as { telemetry: ITelemetry }).telemetry = {
    startActiveSpan: <T>(
      _name: string,
      _options: unknown,
      run: (span: unknown) => Promise<T>,
    ) =>
      run({
        setAttribute: () => undefined,
        recordException: () => undefined,
        setStatus: () => undefined,
        end: () => undefined,
      }),
  } as unknown as ITelemetry;
  await plugin.setup();

  const handlers = new Map<string, RequestHandler>();
  const record =
    (method: string) => (path: string, handler: RequestHandler) => {
      handlers.set(`${method} ${path}`, handler);
    };
  plugin.injectRoutes({
    get: record("get"),
    post: record("post"),
    patch: record("patch"),
    delete: record("delete"),
  } as unknown as Parameters<typeof plugin.injectRoutes>[0]);

  const invoke = async (
    method: "post" | "patch",
    path: string,
    body: unknown,
    params: Record<string, string> = {},
  ) => {
    const response = fakeResponse();
    const handler = handlers.get(`${method} ${path}`) as unknown as (
      req: Request,
      res: Response,
    ) => Promise<void>;
    await handler(
      {
        originalUrl: path.replace(":id", params.id ?? ":id"),
        url: path.replace(":id", params.id ?? ":id"),
        params,
        body,
        is: () => true,
      } as unknown as Request,
      response.res,
    );
    return response;
  };

  const post = (path: string, body: unknown) => invoke("post", path, body);
  const patch = (path: string, id: string, body: unknown) =>
    invoke("patch", path, body, { id });
  return { plugin, database, post, patch };
}

const databaseOf = (plugin: DatabasePlugin<typeof schema>) =>
  plugin.exports() as unknown as {
    notes: { create(values: Row): Promise<Row> };
    transaction<T>(
      callback: (tx: {
        notes: { create(values: Row): Promise<Row> };
        audits: { create(values: Row): Promise<Row> };
      }) => Promise<T>,
    ): Promise<T>;
  };

let context: Awaited<ReturnType<typeof mockServiceContext>>;

beforeEach(async () => {
  mocks.initializeLakebasePool.mockReset();
  mocks.createDrizzleDb.mockReset();
  mocks.createDrizzleDataPath.mockReset();
  context = await mockServiceContext();
});

afterEach(() => {
  context.restore();
});

describe("generated CRUD and explicit transactions", () => {
  test("commits a note and its related audit write together", async () => {
    const { plugin, database } = await mount();

    const created = await databaseOf(plugin).transaction(async (tx) => {
      const note = await tx.notes.create({ body: "hello" });
      await tx.audits.create({ action: `created:${note.id}` });
      return note;
    });

    expect(created).toEqual({ id: 1, body: "hello" });
    expect(database.committed.notes).toEqual([{ id: 1, body: "hello" }]);
    expect(database.committed.audits).toEqual([{ id: 2, action: "created:1" }]);
    expect(database.log).toEqual([
      "begin",
      "insert:notes",
      "insert:audits",
      "commit",
    ]);
  });

  test("rolls both writes back when the transaction callback fails", async () => {
    const { plugin, database } = await mount();

    const error = await databaseOf(plugin)
      .transaction(async (tx) => {
        await tx.notes.create({ body: "hello" });
        await tx.audits.create({ action: "created" });
        throw new Error("audit sink rejected 'hello'");
      })
      .catch((caught) => caught);

    expect(error).toMatchObject({ category: "INTERNAL", phase: "transaction" });
    expect(error.message).not.toContain("audit sink");
    expect(database.committed).toEqual({ notes: [], audits: [] });
    expect(database.log).toEqual([
      "begin",
      "insert:notes",
      "insert:audits",
      "rollback",
    ]);
  });

  test("keeps a transaction callback's validation error and writes nothing", async () => {
    const { plugin, database } = await mount();
    const issues = [
      { path: ["body"], message: "must not be empty" },
      { path: ["secret"], message: "leaks a private column" },
    ];

    const error = await databaseOf(plugin)
      .transaction(async () => {
        throw new DatabaseValidationError("invalid note", issues);
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(DatabaseValidationError);
    expect(error.issues).toEqual(issues);
    expect(database.committed.notes).toEqual([]);
    expect(database.log).toEqual(["begin", "rollback"]);
  });

  test("explains an empty patch without changing the stored row", async () => {
    const { database, patch } = await mount();
    database.committed.notes.push({ id: 1, body: "original" });
    const response = await patch("/notes/:id", "1", {});

    expect(response.sent.status).toBe(400);
    expect(response.json()).toEqual({
      error: "Invalid database request",
      details: [
        {
          path: ["body"],
          message:
            "Update must contain at least one field; skip the call when there are no changes",
        },
      ],
    });
    expect(database.committed.notes).toEqual([{ id: 1, body: "original" }]);
    expect(database.log).toEqual([]);
  });

  test("commits a direct create without opening a transaction", async () => {
    const { plugin, database, post } = await mount();

    const response = await post("/notes", { body: "hello" });
    const direct = await databaseOf(plugin).notes.create({ body: "again" });

    expect(response.sent.status).toBe(201);
    expect(response.json()).toEqual({ id: 1, body: "hello" });
    expect(direct).toEqual({ id: 2, body: "again" });
    expect(database.log).toEqual(["insert:notes", "insert:notes"]);
  });
});
