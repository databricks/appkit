import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { context, propagation, SpanKind, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { PluginManifest } from "shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { z } from "zod";

import type { Schema } from "../../../database/schema-builder";
import { defineSchema, fk, id, text } from "../../../database/schema-builder";
import { Plugin, toPlugin } from "../../../plugin";
import { TelemetryManager } from "../../../telemetry";
import { createTestApp } from "../../../testing";
import { createWorkspaceClient } from "../../../workspace-client";
import { server } from "../../server";

const mocks = vi.hoisted(() => ({
  initializeLakebasePool: vi.fn(),
  createDrizzleDb: vi.fn(),
  createDrizzleDataPath: vi.fn(),
}));

vi.mock("../../../connectors/lakebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../connectors/lakebase")>()),
  initializeLakebasePool: mocks.initializeLakebasePool,
}));
vi.mock("../../../database/runtime/engine/drizzle-data-path", () => ({
  createDrizzleDb: mocks.createDrizzleDb,
  createDrizzleDataPath: mocks.createDrizzleDataPath,
}));
// The catalog comparison has its own suite; the fake database has no catalog.
vi.mock("../schema-check", () => ({
  assertSchemaMatchesDatabase: async () => undefined,
}));

import { database } from "../database";
import {
  type Actor,
  type DatabaseRoutes,
  defineOperation,
  definePolicy,
} from "../operations";
import {
  memoryDatabase,
  send,
  SENTINEL,
  startWorkspace,
} from "./operation-edges";

// The package has no generated registry, so these declarations take the
// untyped path of a JavaScript route module.
const define = defineOperation as unknown as (
  definition: Readonly<Record<string, unknown>>,
) => unknown;
const policy = definePolicy as unknown as (
  definition: Readonly<Record<string, unknown>>,
) => unknown;

const schema = defineSchema((builder) => {
  const notes = builder.table("notes", {
    id: id(),
    title: text().notNull(),
    ownerId: text(),
    secret: text().private(),
  });
  const note_events = builder.table("note_events", {
    id: id(),
    noteId: fk(() => notes.id).notNull(),
    action: text().notNull(),
  });
  return { notes, note_events };
});

/** What the fixture modules assume of the trusted `db` the runtime passes them. */
interface NoteRow {
  readonly id: number;
  readonly title: string;
  readonly ownerId: string | null;
  readonly secret?: string | null;
}
interface FixtureDatabase {
  readonly notes: {
    find(id: number): Promise<NoteRow | null>;
    create(values: Readonly<Record<string, unknown>>): Promise<NoteRow>;
    toArray(): Promise<NoteRow[]>;
  };
  readonly note_events: {
    create(values: Readonly<Record<string, unknown>>): Promise<object>;
  };
  transaction<T>(run: (tx: FixtureDatabase) => Promise<T>): Promise<T>;
}
interface Ctx<In, R = undefined> {
  readonly actor: Actor;
  readonly db: FixtureDatabase;
  readonly input: In;
  readonly resource: R;
}

const NOTES_FILE = "server/database/routes/notes.ts";
const ARCHIVE_FILE = "server/database/routes/archive.ts";

/** Records each executor run, so a test can tell what executed. */
function executions() {
  return {
    get: vi.fn(),
    create: vi.fn(),
    titles: vi.fn(),
    archive: vi.fn(),
    unguarded: vi.fn(),
  };
}
type Executions = ReturnType<typeof executions>;

/** `server/database/routes/notes.ts` as an application would write it. */
function notesModule(ran: Executions): Record<string, unknown> {
  const getNote = define({
    name: "notes.get",
    entity: "notes",
    method: "GET",
    authorize: policy({
      resource: ({ db, input }: Ctx<{ id: number }>) => db.notes.find(input.id),
      allow: ({ actor, resource }: Ctx<{ id: number }, NoteRow>) =>
        resource.ownerId === actor.id,
    }),
    execute: ({ resource }: Ctx<{ id: number }, NoteRow>) => {
      ran.get();
      return resource;
    },
  });
  const createNote = define({
    name: "notes.create",
    entity: "notes",
    method: "POST",
    input: z.object({ title: z.string().min(1).max(200) }),
    authorize: ({ actor }: Ctx<{ title: string }>) => actor.email !== undefined,
    execute: ({ db, actor, input }: Ctx<{ title: string }>) => {
      ran.create();
      return db.transaction(async (tx) => {
        const note = await tx.notes.create({
          title: input.title,
          ownerId: actor.id,
          secret: SENTINEL.privateColumn,
        });
        await tx.note_events.create({ noteId: note.id, action: "created" });
        return note;
      });
    },
  });
  const listTitles = define({
    name: "notes.titles",
    entity: "notes",
    method: "GET",
    input: z.object({}),
    output: z.array(z.object({ id: z.number(), title: z.string() })),
    authorize: ({ actor }: Ctx<object>) => actor.email !== undefined,
    execute: async ({ db, actor }: Ctx<object>) => {
      ran.titles();
      const rows = await db.notes.toArray();
      return rows.filter((row) => row.ownerId === actor.id);
    },
  });
  const unguarded = define({
    name: "notes.unguarded",
    entity: "notes",
    method: "GET",
    execute: ran.unguarded,
  });
  // An ordinary helper export is not a route.
  const titleOf = (note: NoteRow) => note.title;
  return { getNote, createNote, listTitles, unguarded, titleOf };
}

/** `server/database/routes/archive.ts`: a policy that refuses with a private reason. */
function archiveModule(ran: Executions): Record<string, unknown> {
  return {
    archiveNote: define({
      name: "notes.archive",
      entity: "notes",
      method: "POST",
      input: z.object({ id: z.number() }),
      output: z.object({ archived: z.boolean() }),
      authorize: policy({
        allow: () => ({ deny: "forbidden", reason: SENTINEL.reason }),
      }),
      execute: ran.archive,
    }),
  };
}

/** A generated-registry shape: a lazy schema and lazy route modules. */
function registry(
  modules: Readonly<Record<string, Record<string, unknown>>>,
  routeSchema: Schema = schema,
): DatabaseRoutes {
  return {
    schema: async () => ({ schema: routeSchema }),
    modules: Object.entries(modules).map(([file, exports]) => ({
      file,
      load: async () => exports,
    })),
  };
}

function fixtureRoutes(ran: Executions): DatabaseRoutes {
  return registry({
    [NOTES_FILE]: notesModule(ran),
    [ARCHIVE_FILE]: archiveModule(ran),
  });
}

/** The boot payload the server injects into index.html, parsed at that boundary. */
const BootPayload = z.object({
  endpoints: z.record(z.string(), z.record(z.string(), z.string())),
  plugins: z.record(z.string(), z.record(z.string(), z.unknown())),
});
type BootPayload = z.infer<typeof BootPayload>;
const DatabaseClientConfig = z.strictObject({
  operations: z.record(
    z.string(),
    z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
  ),
});
/** A default note reply: exactly the public columns. */
const PublicNote = z.strictObject({
  id: z.number(),
  title: z.string(),
  ownerId: z.string().nullable(),
});

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

const json = (reply: Reply): unknown => JSON.parse(reply.body);

/**
 * A plugin that contributes `processor` during setup, the way an exporter
 * plugin does, so the app's own tracer provider delivers spans there.
 */
function traceExport(processor: SimpleSpanProcessor) {
  class TraceExport extends Plugin {
    static manifest = {
      name: "traceExport",
      displayName: "Trace export",
      description: "Delivers every exported span to one processor",
      resources: { required: [], optional: [] },
    } satisfies PluginManifest<"traceExport">;

    async setup(): Promise<void> {
      TelemetryManager.registerSpanProcessor(processor);
    }
  }
  return toPlugin(TraceExport)();
}

let workspace: Awaited<ReturnType<typeof startWorkspace>>;
let staticPath: string;
let logs: string[];
let open: { close(): Promise<void> } | undefined;

beforeAll(async () => {
  workspace = await startWorkspace();
  staticPath = mkdtempSync(path.join(tmpdir(), "appkit-database-operations-"));
  writeFileSync(
    path.join(staticPath, "index.html"),
    "<!doctype html><html><head></head><body></body></html>",
  );
});

afterAll(async () => {
  await workspace.close();
  rmSync(staticPath, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.initializeLakebasePool.mockReset();
  mocks.createDrizzleDb.mockReset();
  mocks.createDrizzleDataPath.mockReset();
  workspace.authorizations.length = 0;
  logs = [];
  for (const level of ["debug", "log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(
        args
          .map((arg) =>
            typeof arg === "string" ? arg : inspect(arg, { depth: 6 }),
          )
          .join(" "),
      );
    });
  }
});

afterEach(async () => {
  await open?.close();
  open = undefined;
  vi.restoreAllMocks();
});

/**
 * Boot the real ServerPlugin and DatabasePlugin through the test harness on an
 * ephemeral port. Only two edges are fake: the workspace that answers SCIM
 * `Me`, for the service principal and for forwarded user tokens, and the
 * Lakebase pool with its Drizzle data path.
 */
async function boot(
  config: Parameters<typeof database>[0],
  processor?: SimpleSpanProcessor,
) {
  const edge = memoryDatabase(Object.keys(schema.$tables));
  mocks.initializeLakebasePool.mockResolvedValue({
    end: async () => undefined,
  });
  mocks.createDrizzleDb.mockReturnValue({});
  mocks.createDrizzleDataPath.mockReturnValue(edge.path);

  const app = await createTestApp({
    plugins: [
      server({ port: 0, host: "127.0.0.1", staticPath }),
      database(config),
      ...(processor ? [traceExport(processor)] : []),
    ],
    client: createWorkspaceClient({ host: workspace.url, token: "token-sp" }),
    // An app named after its main entity: env values occur inside operation
    // names, which the boot payload must still publish intact.
    env: {
      DATABRICKS_HOST: workspace.url,
      DATABRICKS_APP_NAME: "notes",
      PGHOST: "lakebase.invalid",
      PGDATABASE: "notes",
      PGPORT: "5432",
      PGSSLMODE: "require",
      LAKEBASE_ENDPOINT: "projects/p/branches/b/endpoints/e",
    },
  });
  open = app;
  // The service principal's own `Me` at boot is not part of any request.
  workspace.authorizations.length = 0;

  const request = async (
    method: string,
    target: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<Reply> => {
    const response = await fetch(new URL(target, app.baseUrl), {
      method,
      headers: {
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
      body: init.body,
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  };

  const html = (await request("GET", "/")).body;
  const script =
    /<script id="__appkit__" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
  const payload: BootPayload = BootPayload.parse(JSON.parse(script ?? "null"));

  /**
   * Call an operation the way the browser client does: the name selects the
   * published endpoint and method, a GET carries one JSON `input` parameter,
   * and a write carries a JSON body.
   */
  const call = (
    name: string,
    input: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> => {
    const endpoint = payload.endpoints.database?.[name];
    const method = DatabaseClientConfig.parse(payload.plugins.database)
      .operations[name];
    if (endpoint === undefined || method === undefined) {
      throw new Error(`${name} is not a published operation`);
    }
    const browser = { "sec-fetch-site": "same-origin", ...headers };
    return method === "GET"
      ? request(
          method,
          `${endpoint}?input=${encodeURIComponent(JSON.stringify(input))}`,
          { headers: browser },
        )
      : request(method, endpoint, {
          body: JSON.stringify(input),
          headers: browser,
        });
  };

  return { app, edge, payload, request, call };
}

const asAda = { "x-forwarded-access-token": SENTINEL.token };
const asBob = { "x-forwarded-access-token": "token-bob" };
const discriminator = (actorId: string) =>
  createHash("sha256").update(`${workspace.url}\0${actorId}`).digest("hex");

describe("a database plugin without routes", () => {
  test.each([
    ["absent", { schema }],
    ["false", { schema, routes: false as const }],
  ])(
    "with routes %s publishes no operation and answers 404 under /api/database/operations/",
    async (_label, config) => {
      const { payload, request, edge } = await boot(config);

      expect(Object.keys(payload.endpoints.database ?? {})).toEqual([]);
      expect(payload.plugins.database?.operations).toBeUndefined();
      const replies = [
        await request(
          "GET",
          `/api/database/operations/notes.get?input=${encodeURIComponent('{"id":1}')}`,
          { headers: asAda },
        ),
        await request("POST", "/api/database/operations/notes.create", {
          body: JSON.stringify({ title: "t" }),
          headers: asAda,
        }),
        await request("GET", "/api/database/operations/", { headers: asAda }),
      ];
      expect(replies.map((reply) => reply.status)).toEqual([404, 404, 404]);
      // Nothing asked the workspace who the caller is, and nothing was stored.
      expect(workspace.authorizations).toEqual([]);
      expect(edge.log).toEqual([]);
    },
  );
});

describe("a database plugin with routes", () => {
  test("publishes each served operation in the boot payload and round-trips GET and POST as JSON", async () => {
    const ran = executions();
    const { payload, call } = await boot({ routes: fixtureRoutes(ran) });

    expect(payload.endpoints.database).toEqual({
      "notes.get": "/api/database/operations/notes.get",
      "notes.create": "/api/database/operations/notes.create",
      "notes.titles": "/api/database/operations/notes.titles",
      "notes.archive": "/api/database/operations/notes.archive",
    });
    expect(DatabaseClientConfig.parse(payload.plugins.database)).toEqual({
      operations: {
        "notes.get": "GET",
        "notes.create": "POST",
        "notes.titles": "GET",
        "notes.archive": "POST",
      },
    });

    const created = await call("notes.create", { title: "Plan" }, asAda);
    expect(created.status).toBe(201);
    const note = PublicNote.parse(json(created));
    expect(note).toEqual({
      id: note.id,
      title: "Plan",
      ownerId: SENTINEL.actorId,
    });

    const read = await call("notes.get", { id: note.id }, asAda);
    expect(read.status).toBe(200);
    expect(json(read)).toEqual(note);

    for (const reply of [created, read]) {
      expect(reply.headers.get("content-type")).toMatch(/^application\/json\b/);
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(reply.headers.get("x-appkit-database-actor")).toBe(
        discriminator(SENTINEL.actorId),
      );
    }
    // Bob is verified but does not own the note: his own tag on an opaque 404.
    const other = await call("notes.get", { id: note.id }, asBob);
    expect(other.status).toBe(404);
    expect(other.headers.get("x-appkit-database-actor")).toBe(
      discriminator("bob-2002"),
    );
    expect(ran.create).toHaveBeenCalledTimes(1);
    expect(ran.get).toHaveBeenCalledTimes(1);
    expect(workspace.authorizations).toEqual([
      `Bearer ${SENTINEL.token}`,
      `Bearer ${SENTINEL.token}`,
      "Bearer token-bob",
    ]);
  });

  test("an operation without authorization warns with its file#export, is not served, and answers 404", async () => {
    const ran = executions();
    const { payload, request } = await boot({ routes: fixtureRoutes(ran) });

    expect(
      logs.filter((line) => line.includes(`${NOTES_FILE}#unguarded`)),
    ).toHaveLength(1);
    expect(Object.keys(payload.endpoints.database ?? {})).not.toContain(
      "notes.unguarded",
    );
    expect(
      Object.keys(
        DatabaseClientConfig.parse(payload.plugins.database).operations,
      ),
    ).not.toContain("notes.unguarded");

    const reply = await request(
      "GET",
      `/api/database/operations/notes.unguarded?input=${encodeURIComponent('{"id":1}')}`,
      { headers: asAda },
    );
    expect(reply.status).toBe(404);
    expect(ran.unguarded).not.toHaveBeenCalled();
  });

  test("an unauthenticated call answers 401, executes nothing, and leaves its JSON body unparsed", async () => {
    const ran = executions();
    const { request, edge } = await boot({ routes: fixtureRoutes(ran) });
    const parse = vi.spyOn(JSON, "parse");
    const bodyWasParsed = () =>
      parse.mock.calls.some(
        ([text]) => typeof text === "string" && text.includes(SENTINEL.input),
      );
    const body = JSON.stringify({ title: SENTINEL.input });
    // A body no JSON parser accepts: a parser running first would answer 400.
    const malformed = `{"title": "${SENTINEL.input}"`;
    const forged = {
      "x-forwarded-user": SENTINEL.actorId,
      "x-forwarded-email": SENTINEL.email,
    };
    const create = "/api/database/operations/notes.create";
    const unknown = "/api/database/operations/notes.missing";

    const replies = [
      await request("POST", create, { body }),
      await request("POST", unknown, { body }),
      await request("POST", create, { body: malformed }),
      await request("POST", unknown, { body: malformed }),
      await request("POST", create, { body, headers: forged }),
      await request("POST", create, {
        body,
        headers: { "x-forwarded-access-token": "token-forged" },
      }),
      await request("POST", create, {
        body,
        headers: { "x-forwarded-access-token": "token-sp" },
      }),
      await request(
        "GET",
        `/api/database/operations/notes.get?input=${encodeURIComponent('{"id":1}')}`,
        { headers: forged },
      ),
    ];

    for (const reply of replies) {
      expect(reply.status).toBe(401);
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(reply.headers.get("x-appkit-database-actor")).toBeNull();
    }
    expect(bodyWasParsed()).toBe(false);
    expect(
      Object.values(ran).filter((spy) => spy.mock.calls.length > 0),
    ).toEqual([]);
    expect(edge.log).toEqual([]);
    // Only the requests that carried a token reached the workspace.
    expect(workspace.authorizations).toEqual([
      "Bearer token-forged",
      "Bearer token-sp",
    ]);

    // The control: once the caller is verified, an unknown name is refused
    // before its body is read, and a known name parses its own body.
    expect(
      (await request("POST", unknown, { body, headers: asAda })).status,
    ).toBe(404);
    expect(bodyWasParsed()).toBe(false);
    const rejected = await request("POST", create, {
      body: malformed,
      headers: asAda,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("x-appkit-database-actor")).toBe(
      discriminator(SENTINEL.actorId),
    );
    expect(bodyWasParsed()).toBe(true);
    expect(
      (await request("POST", create, { body, headers: asAda })).status,
    ).toBe(201);
    expect(ran.create).toHaveBeenCalledTimes(1);
  });

  test("an absolute-form request target is authenticated before its body is parsed, like its path", async () => {
    const ran = executions();
    const { app, edge } = await boot({ routes: fixtureRoutes(ran) });
    const parse = vi.spyOn(JSON, "parse");
    const bodyWasParsed = () =>
      parse.mock.calls.some(
        ([text]) => typeof text === "string" && text.includes(SENTINEL.input),
      );
    const url = `${app.baseUrl}/api/database/operations/notes.create`;
    const write = (headers: Record<string, string>) =>
      send(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ title: SENTINEL.input }),
        absoluteForm: true,
      });

    expect((await write({})).status).toBe(401);
    expect(bodyWasParsed()).toBe(false);
    expect((await write(asAda)).status).toBe(201);
    expect(ran.create).toHaveBeenCalledTimes(1);
    expect(edge.committed.notes.map((row) => row.title)).toEqual([
      SENTINEL.input,
    ]);
  });

  test("the removed table CRUD routes answer 404 and reach neither the workspace nor the database", async () => {
    const { request, edge } = await boot({
      routes: fixtureRoutes(executions()),
    });
    const body = JSON.stringify({ title: "t" });

    const replies = [
      await request("GET", "/api/database/notes", { headers: asAda }),
      await request("GET", "/api/database/notes/1", { headers: asAda }),
      await request("GET", "/api/database/notes?limit=10", { headers: asAda }),
      await request("POST", "/api/database/notes", { body, headers: asAda }),
      await request("PATCH", "/api/database/notes/1", {
        body,
        headers: asAda,
      }),
      await request("PUT", "/api/database/notes/1", { body, headers: asAda }),
      await request("DELETE", "/api/database/notes/1", { headers: asAda }),
      await request("GET", "/api/database/note_events", { headers: asAda }),
    ];

    expect(replies.map((reply) => reply.status)).toEqual([
      404, 404, 404, 404, 404, 404, 404, 404,
    ]);
    expect(workspace.authorizations).toEqual([]);
    expect(edge.log).toEqual([]);
  });

  test("a note and its event commit in one explicit transaction, and a failed event write rolls both back", async () => {
    const ran = executions();
    const { call, edge } = await boot({ routes: fixtureRoutes(ran) });

    const created = await call("notes.create", { title: "Kept" }, asAda);
    expect(created.status).toBe(201);
    const note = PublicNote.parse(json(created));
    expect(edge.committed.notes).toEqual([
      {
        id: note.id,
        title: "Kept",
        ownerId: SENTINEL.actorId,
        secret: SENTINEL.privateColumn,
      },
    ]);
    expect(edge.committed.note_events).toEqual([
      { id: expect.any(Number), noteId: note.id, action: "created" },
    ]);
    expect(edge.log).toEqual([
      "begin",
      "insert:notes",
      "insert:note_events",
      "commit",
    ]);

    // The fake database refuses the event row, like a constraint violation.
    edge.refuseInserts("note_events");
    edge.log.length = 0;
    const failed = await call("notes.create", { title: "Rolled back" }, asAda);

    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain(SENTINEL.error);
    expect(edge.committed.notes.map((row) => row.title)).toEqual(["Kept"]);
    expect(edge.committed.note_events).toHaveLength(1);
    expect(edge.log).toEqual(["begin", "insert:notes", "rollback"]);
    expect(ran.create).toHaveBeenCalledTimes(2);
  });

  test("private columns never reach a response", async () => {
    const { call, edge } = await boot({ routes: fixtureRoutes(executions()) });

    const created = await call("notes.create", { title: "Mine" }, asAda);
    const note = PublicNote.parse(json(created));
    // The control: the private value is stored, so only projection can hide it.
    expect(edge.committed.notes[0]?.secret).toBe(SENTINEL.privateColumn);

    const read = await call("notes.get", { id: note.id }, asAda);
    const titles = await call("notes.titles", {}, asAda);
    const missing = await call("notes.get", { id: 999 }, asAda);
    const notOwned = await call("notes.get", { id: note.id }, asBob);

    expect([created.status, read.status, titles.status]).toEqual([
      201, 200, 200,
    ]);
    expect(PublicNote.parse(json(read))).toEqual(note);
    expect(json(titles)).toEqual([{ id: note.id, title: "Mine" }]);
    expect([missing.status, notOwned.status]).toEqual([404, 404]);
    for (const reply of [created, read, titles, missing, notOwned]) {
      expect(reply.body).not.toContain("secret");
      expect(reply.body).not.toContain(SENTINEL.privateColumn);
    }
  });
});

describe("setup", () => {
  const ran = executions();
  const sameName = define({
    name: "notes.get",
    entity: "notes",
    method: "GET",
    authorize: () => true,
    execute: () => null,
  });
  const otherSchema = defineSchema((builder) => ({
    notes: builder.table("notes", { id: id(), title: text().notNull() }),
  }));

  test.each<[string, Parameters<typeof database>[0], RegExp]>([
    [
      "a malformed declaration",
      {
        routes: registry({
          [NOTES_FILE]: {
            broken: define({
              name: "notes.broken",
              entity: "notes",
              method: "FETCH",
              authorize: () => true,
              execute: () => null,
            }),
          },
        }),
      },
      /server\/database\/routes\/notes\.ts#broken must use GET, POST, PATCH, PUT, or DELETE/,
    ],
    [
      "a duplicate name in another module",
      {
        routes: registry({
          [NOTES_FILE]: notesModule(ran),
          [ARCHIVE_FILE]: { sameName },
        }),
      },
      /archive\.ts#sameName repeats operation name "notes\.get", already exported by server\/database\/routes\/notes\.ts#getNote/,
    ],
    [
      "a schema that is not the one the registry loads",
      { schema: otherSchema, routes: fixtureRoutes(ran) },
      /is not the schema the routes registry loads/,
    ],
    [
      "an entity the registry schema lacks",
      {
        routes: registry({
          [NOTES_FILE]: {
            ghost: define({
              name: "ghosts.get",
              entity: "ghosts",
              method: "GET",
              authorize: () => true,
              execute: () => null,
            }),
          },
        }),
      },
      /routes\/notes\.ts#ghost must name one entity in the database schema/,
    ],
  ])(
    "%s fails setup before a connection opens",
    async (_label, config, reason) => {
      await expect(boot(config)).rejects.toThrow(reason);
      expect(mocks.initializeLakebasePool).not.toHaveBeenCalled();
      expect(
        Object.values(ran).filter((spy) => spy.mock.calls.length > 0),
      ).toEqual([]);
    },
  );

  test("a module that fails to import fails setup without repeating the import error", async () => {
    const missing = `./missing-${SENTINEL.error}.ts`;
    const routes: DatabaseRoutes = {
      schema: async () => ({ schema }),
      modules: [
        { file: NOTES_FILE, load: async () => notesModule(ran) },
        {
          file: "server/database/routes/missing.ts",
          load: () => import(/* @vite-ignore */ missing),
        },
      ],
    };

    const failure = await boot({ routes }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(
      /Could not load the database routes module "server\/database\/routes\/missing\.ts"/,
    );
    expect(String(failure)).not.toContain(SENTINEL.error);
    expect(
      logs.filter((line) => line.startsWith("[appkit:")).join("\n"),
    ).not.toContain(SENTINEL.error);
    expect(mocks.initializeLakebasePool).not.toHaveBeenCalled();
  });
});

describe("privacy", () => {
  /** Every exported span field a collector receives. */
  const exportedText = (spans: readonly ReadableSpan[]) =>
    JSON.stringify(
      spans.map((span) => ({
        name: span.name,
        kind: span.kind,
        attributes: span.attributes,
        events: span.events,
        links: span.links,
        status: span.status,
        resource: span.resource.attributes,
      })),
    );

  test("sentinel row values, tokens, inputs, and error messages stay out of exported spans and logs", async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    try {
      const { app, call, edge, request } = await boot(
        { routes: fixtureRoutes(executions()) },
        processor,
      );
      // The control: a database span outside any operation is exported with its row values.
      await edge.path.insert(schema.$tables.notes, { title: SENTINEL.row });
      await processor.forceFlush();
      expect(exportedText(exporter.getFinishedSpans())).toContain(SENTINEL.row);
      exporter.reset();

      const created = await call(
        "notes.create",
        { title: SENTINEL.row },
        asAda,
      );
      const note = PublicNote.parse(json(created));
      const replies = [
        created,
        await call("notes.get", { id: note.id }, asAda),
        await call("notes.get", { id: SENTINEL.input }, asAda),
        await call("notes.archive", { id: note.id }, asAda),
        await call(
          "notes.get",
          { id: note.id },
          {
            "x-forwarded-access-token": "token-forged",
            "x-forwarded-email": SENTINEL.email,
          },
        ),
      ];
      edge.refuseInserts("note_events");
      replies.push(
        await call("notes.create", { title: SENTINEL.input }, asAda),
      );
      expect(replies.map((reply) => reply.status)).toEqual([
        201, 200, 400, 403, 401, 500,
      ]);
      // Targets Express routes into the same mount: another letter case, the
      // mount itself, and the absolute form a proxy client sends.
      const query = `?input=${encodeURIComponent(JSON.stringify({ id: SENTINEL.input }))}`;
      const variants = [
        await request("GET", `/API/Database/Operations/notes.get${query}`, {
          headers: asAda,
        }),
        await request("GET", `/api/database/operations${query}`, {
          headers: asAda,
        }),
        await send(`${app.baseUrl}/api/database/operations/notes.get${query}`, {
          headers: asAda,
          absoluteForm: true,
        }),
      ];
      expect(variants.map((reply) => reply.status)).toEqual([400, 404, 400]);

      // The fake workspace runs in-process; its own server spans are not the app's.
      const workspaceHost = new URL(workspace.url).host;
      const appSpans = () =>
        exporter
          .getFinishedSpans()
          .filter((span) => span.attributes["http.host"] !== workspaceHost);
      const requestSpans = () =>
        appSpans().filter((span) => span.kind === SpanKind.SERVER);
      await vi.waitFor(async () => {
        await processor.forceFlush();
        expect(requestSpans()).toHaveLength(9);
      });
      const spans = appSpans();

      expect(
        spans
          .filter((span) => span.name === "database.operation")
          .map((span) => [
            span.attributes["database.operation.name"],
            span.attributes["database.operation.outcome"],
            span.attributes["database.operation.stage"],
          ]),
      ).toEqual([
        ["notes.create", "success", undefined],
        ["notes.get", "success", undefined],
        ["notes.get", "INVALID_REQUEST", "input"],
        ["notes.archive", "FORBIDDEN", "allow"],
        [undefined, "UNAUTHENTICATED", "actor"],
        ["notes.create", "INTERNAL", "execute"],
        ["notes.get", "INVALID_REQUEST", "input"],
        [undefined, "NOT_FOUND", "route"],
        ["notes.get", "INVALID_REQUEST", "input"],
      ]);
      const exported = exportedText(spans);
      const logged = logs.join("\n");
      for (const [label, value] of Object.entries(SENTINEL)) {
        expect(exported, `exported spans carry ${label}`).not.toContain(value);
        expect(logged, `logs carry ${label}`).not.toContain(value);
      }
      expect(exported).not.toContain(discriminator(SENTINEL.actorId));
    } finally {
      await open?.close();
      open = undefined;
      // The tracer provider the app registered is global; drop it with the app.
      trace.disable();
      context.disable();
      propagation.disable();
    }
  });
});
