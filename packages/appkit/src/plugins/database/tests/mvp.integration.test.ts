import { createMockTelemetry, mockServiceContext } from "@tools/test-helpers";
import type { Request, RequestHandler, Response } from "express";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_LIMIT } from "../../../database/contract";
import type { DataPath, QuerySpec, Row } from "../../../database/runtime";
import { defineSchema, fk, id, text } from "../../../database/schema-builder";
import type { ITelemetry } from "../../../telemetry";
import type { DatabaseExports } from "../entity-types";
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
  const boards = builder.table("boards", {
    id: id(),
    title: text().notNull(),
    retention_note: text().private(),
  });
  const notes = builder.table("notes", {
    id: id(),
    board_id: fk(() => boards.id).notNull(),
    body: text().notNull(),
  });
  return { boards, notes };
});

/** What an included read returns: relation rows nested under their parent. */
const storedBoard: Row = {
  id: 7,
  title: "Q3 review",
  retention_note: "delete after the audit",
  notes: [{ id: 1, board_id: 7, body: "looks off" }],
};

/**
 * Answers every read with the same row, so the assertions can look at the spec
 * the plugin composed and at what survived on the way back to the wire.
 */
function recordingDataPath() {
  const reads: QuerySpec[] = [];
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const path: DataPath = {
    select: async (_table, spec) => {
      reads.push(spec);
      return [storedBoard];
    },
    findOne: async (_table, _value, spec) => {
      reads.push(spec ?? {});
      return storedBoard;
    },
    count: async () => 1,
    insert: async (_table, values) => values,
    update: async (_table, _value, values) => values,
    upsert: async (_table, values) => values,
    delete: async () => true,
    // The driver infers the row shape from the statement; a stub cannot.
    raw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ text: strings.join("?"), values });
      return [{ notes: "3" }];
    }) as unknown as DataPath["raw"],
    transaction: async (callback) => callback(path),
  };
  return { path, reads, statements };
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

async function mount(hooks?: Record<string, EntityHooks>) {
  const database = recordingDataPath();
  const end = vi.fn(async () => undefined);
  mocks.createLakebasePool.mockReturnValue({ end });
  mocks.createDrizzleDb.mockReturnValue({});
  mocks.createDrizzleDataPath.mockReturnValue(database.path);

  const plugin = new DatabasePlugin({
    schema,
    crudRoutes: { tables: ["boards", "notes"] },
    hooks,
  });
  (plugin as unknown as { telemetry: ITelemetry }).telemetry =
    createMockTelemetry();
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

  const get = async (
    route: string,
    url: string,
    params: Record<string, string> = {},
  ) => {
    const response = fakeResponse();
    const handler = handlers.get(`get ${route}`) as unknown as (
      req: Request,
      res: Response,
    ) => Promise<void>;
    await handler(
      { originalUrl: url, url, params } as unknown as Request,
      response.res,
    );
    return response;
  };

  return {
    plugin,
    database,
    end,
    list: (query = "") => get("/boards", `/boards${query}`),
    detail: (id: string) => get("/boards/:id", `/boards/${id}`, { id }),
  };
}

const exportsOf = (plugin: DatabasePlugin<typeof schema>) =>
  plugin.exports() as unknown as DatabaseExports;

let context: Awaited<ReturnType<typeof mockServiceContext>>;

beforeEach(async () => {
  mocks.createLakebasePool.mockReset();
  mocks.createDrizzleDb.mockReset();
  mocks.createDrizzleDataPath.mockReset();
  // A read runs through Plugin.execute(), which keys on the current identity.
  context = await mockServiceContext();
});

afterEach(() => {
  context.restore();
});

describe("the assembled MVP", () => {
  test("carries a generated read from the query string to the DataPath", async () => {
    const { database, list } = await mount();
    const include = encodeURIComponent('{"notes":true}');

    const response = await list(`?limit=2&include=${include}`);

    expect(response.sent.status).toBe(200);
    // The unqualified include arrives bounded, and the key breaks order ties.
    expect(database.reads).toEqual([
      {
        order: { id: "asc" },
        limit: 2,
        offset: 0,
        include: { notes: { limit: DEFAULT_LIMIT } },
      },
    ]);
  });

  test("shapes the response without the private column", async () => {
    const { list, detail } = await mount({
      boards: {
        serialize: (row, { operation }) => ({ ...row, read_as: operation }),
      },
    });

    const page = await list();
    const one = await detail("7");

    expect(page.json()).toEqual({
      items: [
        {
          id: 7,
          title: "Q3 review",
          notes: [{ id: 1, board_id: 7, body: "looks off" }],
          read_as: "list",
        },
      ],
      limit: DEFAULT_LIMIT,
      offset: 0,
    });
    expect(one.json().read_as).toBe("detail");
    expect(page.sent.body).not.toContain("retention_note");
    expect(one.sent.body).not.toContain("retention_note");
  });

  test("sends tagged SQL interpolations as bound values", async () => {
    const { plugin, database } = await mount();

    const rows = await exportsOf(plugin).sql<{
      notes: string;
    }>`select count(*)::text as notes from notes where board_id = ${7}`;

    expect(rows).toEqual([{ notes: "3" }]);
    // Setup ran the readiness probe first; this is the caller's statement.
    expect(database.statements.at(-1)).toEqual({
      text: "select count(*)::text as notes from notes where board_id = ?",
      values: [7],
    });
  });

  test("closes the pool and stops answering once it has shut down", async () => {
    const { plugin, end, list } = await mount();

    await plugin.shutdown();

    expect(end).toHaveBeenCalledOnce();
    expect(() => plugin.exports()).toThrow();
    expect((await list()).sent.status).toBe(500);
  });
});
