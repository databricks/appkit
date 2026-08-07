import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DataPath, Row } from "../../../database/runtime";
import { defineSchema, id, text } from "../../../database/schema-builder";
import { DatabaseValidationError } from "../../../errors";
import type { ITelemetry } from "../../../telemetry";
import type { EntityHooks } from "../types";

const mocks = vi.hoisted(() => ({
  createLakebasePool: vi.fn(),
  createDrizzleDb: vi.fn(),
  createDrizzleDataPath: vi.fn(),
}));

vi.mock("../../../connectors/lakebase", () => ({
  createLakebasePool: mocks.createLakebasePool,
}));
vi.mock("../../../database/runtime/engine/drizzle-data-path", () => ({
  createDrizzleDb: mocks.createDrizzleDb,
  createDrizzleDataPath: mocks.createDrizzleDataPath,
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

async function mount(hooks: Record<string, EntityHooks>) {
  const database = memoryDataPath();
  mocks.createLakebasePool.mockReturnValue({
    end: vi.fn(async () => undefined),
  });
  mocks.createDrizzleDb.mockReturnValue({});
  mocks.createDrizzleDataPath.mockReturnValue(database.path);

  const plugin = new DatabasePlugin({ schema, crudRoutes: true, hooks });
  (plugin as unknown as { telemetry: ITelemetry }).telemetry = {
    startActiveSpan: <T>(
      _name: string,
      _options: unknown,
      run: (span: unknown) => Promise<T>,
    ) => run({ setAttribute: () => undefined, end: () => undefined }),
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

  const post = async (path: string, body: unknown) => {
    const response = fakeResponse();
    const handler = handlers.get(`post ${path}`) as unknown as (
      req: Request,
      res: Response,
    ) => Promise<void>;
    await handler(
      {
        originalUrl: path,
        url: path,
        params: {},
        body,
        is: () => true,
      } as unknown as Request,
      response.res,
    );
    return response;
  };

  return { plugin, database, post };
}

const notesOf = (plugin: DatabasePlugin<typeof schema>) =>
  plugin.exports() as unknown as {
    notes: { create(values: Row): Promise<Row> };
  };

const auditingHooks: Record<string, EntityHooks> = {
  notes: {
    afterCreate: async (row, context) => {
      const tx = context.app.database as unknown as {
        audits: { create(values: Row): Promise<Row> };
      };
      await tx.audits.create({ action: `created:${row.id}` });
    },
  },
};

beforeEach(() => {
  mocks.createLakebasePool.mockReset();
  mocks.createDrizzleDb.mockReset();
  mocks.createDrizzleDataPath.mockReset();
});

describe("generated CRUD over hooked mutations", () => {
  test("commits the mutation and the hook's related write together", async () => {
    const { database, post } = await mount(auditingHooks);

    const response = await post("/notes", { body: "hello" });

    expect(response.sent.status).toBe(201);
    expect(response.json()).toEqual({ id: 1, body: "hello" });
    expect(database.committed.notes).toEqual([{ id: 1, body: "hello" }]);
    expect(database.committed.audits).toEqual([{ id: 2, action: "created:1" }]);
    expect(database.log).toEqual([
      "begin",
      "insert:notes",
      "insert:audits",
      "commit",
    ]);
  });

  test("rolls both writes back when the hook fails after the mutation", async () => {
    const { database, post } = await mount({
      notes: {
        afterCreate: async (_row, context) => {
          const tx = context.app.database as unknown as {
            audits: { create(values: Row): Promise<Row> };
          };
          await tx.audits.create({ action: "created" });
          throw new Error("audit sink rejected 'hello'");
        },
      },
    });

    const response = await post("/notes", { body: "hello" });

    expect(response.sent.status).toBe(500);
    expect(response.json()).toEqual({ error: "Database operation failed" });
    expect(response.sent.body).not.toContain("audit sink");
    expect(database.committed).toEqual({ notes: [], audits: [] });
    expect(database.log).toEqual([
      "begin",
      "insert:notes",
      "insert:audits",
      "rollback",
    ]);
  });

  test("answers a before hook's validation failure with 422 and writes nothing", async () => {
    const { database, post } = await mount({
      notes: {
        beforeCreate: () => {
          throw new DatabaseValidationError("invalid note", [
            { path: ["body"], message: "must not be empty" },
            { path: ["secret"], message: "leaks a private column" },
          ]);
        },
      },
    });

    const response = await post("/notes", { body: "" });

    expect(response.sent.status).toBe(422);
    expect(response.json()).toEqual({
      error: "Database request failed validation",
      details: [{ path: ["body"], message: "must not be empty" }],
    });
    expect(response.sent.body).not.toContain("secret");
    expect(database.committed.notes).toEqual([]);
    expect(database.log).toEqual(["begin", "rollback"]);
  });

  test("gives a programmatic caller the same lifecycle as the route", async () => {
    const seen: string[] = [];
    const trace: Record<string, EntityHooks> = {
      notes: {
        beforeCreate: (values) => {
          seen.push("before");
          return { ...values, body: `${values.body}!` };
        },
        afterCreate: (row) => {
          seen.push(`after:${row.body}`);
        },
      },
    };

    const http = await mount(trace);
    await http.post("/notes", { body: "a" });
    const overHttp = [...seen, ...http.database.log];

    seen.length = 0;
    const direct = await mount(trace);
    await notesOf(direct.plugin).notes.create({ body: "a" });

    expect([...seen, ...direct.database.log]).toEqual(overHttp);
    expect(direct.database.committed.notes).toEqual([{ id: 1, body: "a!" }]);
  });
});
