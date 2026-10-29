import { createHash } from "node:crypto";
import http, { type Server } from "node:http";
import { inspect } from "node:util";

import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { mockServiceContext } from "@tools/test-helpers";
import express from "express";
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

import { DatabasePluginError } from "../../../database/errors";
import {
  bigint,
  defineSchema,
  fk,
  id,
  text,
} from "../../../database/schema-builder";
import { TelemetryManager } from "../../../telemetry";
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
vi.mock("../schema-check", () => ({
  assertSchemaMatchesDatabase: async () => undefined,
}));

import { DatabasePlugin } from "../database";
import { type ActorResolver, createActorResolver } from "../operation-actor";
import { validateOperationMetadata } from "../operation-metadata";
import { createOperationHandler, OPERATIONS_PATH } from "../operation-runtime";
import { defineOperation, definePolicy } from "../operations";
import {
  close,
  listen,
  memoryDatabase,
  type Reply,
  SENTINEL,
  send,
  startWorkspace,
  stringify,
} from "./operation-edges";

// The package has no generated registry, so these calls take the untyped JS path.
const define = defineOperation as unknown as (
  definition: Record<string, unknown>,
) => unknown;
const policy = definePolicy as unknown as (
  definition: Record<string, unknown>,
) => unknown;
type Ctx = {
  actor: { id: string; email?: string };
  db: Record<string, any>;
  input: any;
  resource?: any;
};

const ADA = { id: SENTINEL.actorId, email: SENTINEL.email };

const schema = defineSchema((builder) => {
  const notes = builder.table("notes", {
    id: id(),
    title: text().notNull(),
    ownerId: text(),
    views: bigint(),
    secret: text().private(),
  });
  const events = builder.table("events", {
    id: id(),
    noteId: fk(() => notes.id).notNull(),
    action: text().notNull(),
  });
  const tags = builder.table("tags", { label: text().notNull() });
  const stamps = builder.table("stamps", { id: id() });
  return { notes, events, tags, stamps };
});

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
let workspace: Awaited<ReturnType<typeof startWorkspace>>;
let serviceContext: Awaited<ReturnType<typeof mockServiceContext>>;
const servers: Server[] = [];
let logs: string[];

beforeAll(async () => {
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  trace.setGlobalTracerProvider(provider);
  workspace = await startWorkspace();
});

afterAll(async () => {
  await workspace.close();
  trace.disable();
  context.disable();
});

beforeEach(async () => {
  mocks.initializeLakebasePool.mockReset();
  mocks.createDrizzleDb.mockReset();
  mocks.createDrizzleDataPath.mockReset();
  serviceContext = await mockServiceContext();
  workspace.authorizations.length = 0;
  exporter.reset();
  logs = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
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
  vi.restoreAllMocks();
  serviceContext.restore();
  await Promise.all(servers.splice(0).map(close));
});

/** Boot a real DatabasePlugin over the fake edge and serve operations over real HTTP. */
async function boot(
  operations: unknown[],
  options: { resolveActor?: ActorResolver; parseAllBodies?: boolean } = {},
) {
  const database = memoryDatabase(Object.keys(schema.$tables));
  mocks.initializeLakebasePool.mockResolvedValue({
    end: async () => undefined,
  });
  mocks.createDrizzleDb.mockReturnValue({});
  mocks.createDrizzleDataPath.mockReturnValue(database.path);
  const plugin = new DatabasePlugin({ schema });
  const telemetry: ITelemetry = TelemetryManager.getProvider("database");
  (plugin as unknown as { telemetry: ITelemetry }).telemetry = telemetry;
  await plugin.setup();

  const located = operations.map((value, index) => ({
    file: "server/database/routes/notes.ts",
    exportName: `operation${index}`,
    value,
  }));
  const validated = validateOperationMetadata(
    located,
    new Set(Object.keys(schema.$tables)),
  );
  expect(validated.skipped).toEqual([]);
  expect(validated.errors).toEqual([]);

  const app = express();
  // The server plugin's global parser must skip the operation namespace.
  app.use(
    express.json({
      type: (req) =>
        options.parseAllBodies === true ||
        !req.url?.startsWith("/api/database/operations"),
    }),
  );
  const router = express.Router();
  router.use(
    OPERATIONS_PATH,
    createOperationHandler({
      schema,
      operations: validated.operations,
      resolveActor:
        options.resolveActor ??
        createActorResolver({ kind: "apps", host: workspace.url }),
      services: () => {
        const db = plugin.exports();
        return { db, appkit: { database: db } };
      },
      telemetry,
    }),
  );
  app.use("/api/database", router);
  const server = http.createServer(app);
  servers.push(server);
  const url = await listen(server);

  const call = (
    method: string,
    name: string,
    input?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> => {
    const target = new URL(`/api/database/operations/${name}`, url);
    if (method === "GET" || method === "HEAD") {
      if (input !== undefined) {
        target.searchParams.set("input", JSON.stringify(input));
      }
      return send(target.href, { method, headers });
    }
    return send(target.href, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  };
  return { url, database, db: () => plugin.exports() as any, call };
}

const asAda = { "x-forwarded-access-token": SENTINEL.token };
const discriminator = (actorId: string) =>
  createHash("sha256").update(`${workspace.url}\0${actorId}`).digest("hex");
const json = (reply: Reply) => JSON.parse(reply.body);

/** A GET whose resource policy reads the note and admits only its owner. */
function ownedNoteGet(
  spies = { lookup: vi.fn(), allow: vi.fn(), execute: vi.fn() },
) {
  return {
    spies,
    operation: define({
      name: "notes.get",
      entity: "notes",
      method: "GET",
      authorize: policy({
        resource: (ctx: Ctx) => {
          spies.lookup(ctx);
          return ctx.db.notes.find(ctx.input.id);
        },
        allow: (ctx: Ctx) => {
          spies.allow(ctx);
          return ctx.resource.ownerId === ctx.actor.id;
        },
      }),
      execute: (ctx: Ctx) => {
        spies.execute(ctx);
        return { ...ctx.resource, events: [{ id: 9, action: "hidden" }] };
      },
    }),
  };
}

async function seedNote(db: any, values: Record<string, unknown> = {}) {
  return db.notes.create({
    title: SENTINEL.row,
    ownerId: SENTINEL.actorId,
    views: 9007199254740993n,
    secret: SENTINEL.row,
    ...values,
  });
}

describe("authentication comes first", () => {
  test("answers 401 before reading input, loading, or executing when no verified token arrives", async () => {
    const get = ownedNoteGet();
    const create = vi.fn();
    const app = await boot([
      get.operation,
      define({
        name: "notes.create",
        entity: "notes",
        method: "POST",
        authorize: () => true,
        execute: create,
      }),
    ]);
    const forged = {
      "x-forwarded-user": SENTINEL.actorId,
      "x-forwarded-email": SENTINEL.email,
    };

    const replies = [
      await send(
        `${app.url}/api/database/operations/notes.get?input=%7Bnot-json`,
        {
          headers: forged,
        },
      ),
      await send(`${app.url}/api/database/operations/notes.create`, {
        method: "POST",
        headers: { ...forged, "content-type": "application/json" },
        body: "{not json",
      }),
      await app.call("GET", "missing.op", { id: 1 }, forged),
      await app.call(
        "GET",
        "notes.get",
        { id: 1 },
        {
          "x-forwarded-access-token": "token-forged",
        },
      ),
      await app.call(
        "GET",
        "notes.get",
        { id: 1 },
        {
          "x-forwarded-access-token": "token-sp",
        },
      ),
    ];

    for (const reply of replies) {
      expect(reply.status).toBe(401);
      expect(json(reply)).toEqual({
        error: "Database request is not authenticated",
      });
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["x-appkit-database-actor"]).toBeUndefined();
    }
    expect(get.spies.lookup).not.toHaveBeenCalled();
    expect(get.spies.execute).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    // Only the two requests that carried a token reached the workspace.
    expect(workspace.authorizations).toEqual([
      "Bearer token-forged",
      "Bearer token-sp",
    ]);
  });

  test("verifies only the forwarded token, never the service principal's credential", async () => {
    vi.stubEnv("DATABRICKS_TOKEN", "service-principal-token");
    vi.stubEnv("DATABRICKS_CLIENT_ID", "service-client");
    vi.stubEnv("DATABRICKS_CLIENT_SECRET", "service-secret");
    const get = ownedNoteGet();
    const app = await boot([get.operation]);
    const note = await seedNote(app.db());

    const reply = await app.call("GET", "notes.get", { id: note.id }, asAda);
    vi.unstubAllEnvs();

    expect(reply.status).toBe(200);
    expect(workspace.authorizations).toEqual([`Bearer ${SENTINEL.token}`]);
  });

  test("answers 503 without an actor when the workspace cannot verify the caller", async () => {
    const get = ownedNoteGet();
    const app = await boot([get.operation]);

    const reply = await app.call(
      "GET",
      "notes.get",
      { id: 1 },
      {
        "x-forwarded-access-token": "token-outage",
      },
    );

    expect(reply.status).toBe(503);
    expect(reply.headers["x-appkit-database-actor"]).toBeUndefined();
    expect(get.spies.lookup).not.toHaveBeenCalled();
  });

  test("tags each authenticated response with a stable per-actor discriminator", async () => {
    const get = ownedNoteGet();
    const app = await boot([get.operation]);
    const note = await seedNote(app.db());

    const first = await app.call("GET", "notes.get", { id: note.id }, asAda);
    const again = await app.call("GET", "notes.get", { id: note.id }, asAda);
    const bob = await app.call(
      "GET",
      "notes.get",
      { id: note.id },
      {
        "x-forwarded-access-token": "token-bob",
      },
    );

    expect(first.status).toBe(200);
    expect(first.headers["x-appkit-database-actor"]).toBe(
      discriminator(SENTINEL.actorId),
    );
    expect(again.headers["x-appkit-database-actor"]).toBe(
      first.headers["x-appkit-database-actor"],
    );
    // Bob is authenticated but does not own the note: an opaque 404, his own tag.
    expect(bob.status).toBe(404);
    expect(bob.headers["x-appkit-database-actor"]).toBe(
      discriminator("bob-2002"),
    );
    expect(get.spies.execute).toHaveBeenCalledTimes(2);
  });
});

describe("routing", () => {
  test("an authenticated request reaches only a declared name with its exact method", async () => {
    const get = ownedNoteGet();
    const app = await boot([get.operation]);
    const note = await seedNote(app.db());
    const path = (suffix: string) =>
      `${app.url}/api/database/operations/${suffix}?input=${encodeURIComponent(JSON.stringify({ id: note.id }))}`;

    const replies = [
      await app.call("GET", "notes.missing", { id: note.id }, asAda),
      await app.call("POST", "notes.get", { id: note.id }, asAda),
      await app.call("DELETE", "notes.get", { id: note.id }, asAda),
      await app.call("HEAD", "notes.get", { id: note.id }, asAda),
      await app.call("GET", "NOTES.GET", { id: note.id }, asAda),
      await send(path("notes.get/extra"), { headers: asAda }),
      await send(path("%E0%A4%A"), { headers: asAda }),
      await send(path(""), { headers: asAda }),
    ];

    expect(replies.map((reply) => reply.status)).toEqual([
      404, 404, 404, 404, 404, 404, 404, 404,
    ]);
    expect(get.spies.lookup).not.toHaveBeenCalled();
    expect(get.spies.execute).not.toHaveBeenCalled();
    expect(
      (await app.call("GET", "notes.get", { id: note.id }, asAda)).status,
    ).toBe(200);
  });
});

describe("input", () => {
  test("a GET reads exactly one bounded JSON input parameter", async () => {
    const get = ownedNoteGet();
    const app = await boot([get.operation]);
    const base = `${app.url}/api/database/operations/notes.get`;
    let deep: unknown = 1;
    for (let depth = 0; depth < 40; depth++) deep = [deep];

    const replies = await Promise.all(
      [
        "",
        "?input=1&input=2",
        `?input=${encodeURIComponent('{"id":1}')}&other=1`,
        `?input=${encodeURIComponent(SENTINEL.input)}`,
        `?input=${encodeURIComponent(JSON.stringify({ id: 1, extra: SENTINEL.input }))}`,
        `?input=${encodeURIComponent(JSON.stringify({ id: SENTINEL.input }))}`,
        `?input=${encodeURIComponent(JSON.stringify({ id: deep }))}`,
        `?input=${"a".repeat(9 * 1024)}`,
      ].map((query) => send(base + query, { headers: asAda })),
    );

    for (const reply of replies) {
      expect(reply.status).toBe(400);
      expect(reply.body).not.toContain(SENTINEL.input);
    }
    expect(get.spies.lookup).not.toHaveBeenCalled();
  });

  test("a write reads one JSON body of bounded size, only after authentication", async () => {
    const execute = vi.fn(() => ({ id: 1, title: "t" }));
    const app = await boot([
      define({
        name: "notes.create",
        entity: "notes",
        method: "POST",
        authorize: () => true,
        execute,
      }),
    ]);
    const url = `${app.url}/api/database/operations/notes.create`;

    const text = await send(url, {
      method: "POST",
      headers: { ...asAda, "content-type": "text/plain" },
      body: JSON.stringify({ title: "t" }),
    });
    const query = await send(`${url}?title=t`, {
      method: "POST",
      headers: { ...asAda, "content-type": "application/json" },
      body: JSON.stringify({ title: "t" }),
    });
    const malformed = await send(url, {
      method: "POST",
      headers: { ...asAda, "content-type": "application/json" },
      body: `{"title": "${SENTINEL.input}"`,
    });
    const large = await send(url, {
      method: "POST",
      headers: { ...asAda, "content-type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(1024 * 1024 + 1) }),
    });

    expect([text.status, query.status, malformed.status, large.status]).toEqual(
      [415, 400, 400, 413],
    );
    expect(malformed.body).not.toContain(SENTINEL.input);
    expect(execute).not.toHaveBeenCalled();
  });

  test("fails closed when a body parser read the body before authentication", async () => {
    const execute = vi.fn(() => ({ id: 1, title: "t" }));
    const app = await boot(
      [
        define({
          name: "notes.create",
          entity: "notes",
          method: "POST",
          authorize: () => true,
          execute,
        }),
      ],
      { parseAllBodies: true },
    );

    const reply = await app.call("POST", "notes.create", { title: "t" }, asAda);

    expect(reply.status).toBe(500);
    expect(execute).not.toHaveBeenCalled();
  });

  test("default inputs accept only the public contract of each method", async () => {
    const seen: unknown[] = [];
    const execute = (ctx: Ctx) => {
      seen.push(ctx.input);
      return null;
    };
    const app = await boot([
      define({
        name: "notes.create",
        entity: "notes",
        method: "POST",
        authorize: () => true,
        execute: (ctx: Ctx) => {
          seen.push(ctx.input);
          return { id: 1, title: "t" };
        },
      }),
      define({
        name: "notes.patch",
        entity: "notes",
        method: "PATCH",
        authorize: () => true,
        execute,
      }),
      define({
        name: "notes.put",
        entity: "notes",
        method: "PUT",
        authorize: () => true,
        execute,
      }),
    ]);

    const missing = await app.call(
      "POST",
      "notes.create",
      { ownerId: "x" },
      asAda,
    );
    const privateField = await app.call(
      "POST",
      "notes.create",
      { title: "t", secret: "s" },
      asAda,
    );
    const incomplete = await app.call(
      "PUT",
      "notes.put",
      { id: 1, values: { title: "t" } },
      asAda,
    );
    const readOnly = await app.call(
      "PATCH",
      "notes.patch",
      { id: 1, changes: { id: 2 } },
      asAda,
    );
    const bigintPatch = await app.call(
      "PATCH",
      "notes.patch",
      { id: "1", changes: { views: "9007199254740993" } },
      asAda,
    );
    const noChanges = await app.call(
      "PATCH",
      "notes.patch",
      { id: 1, changes: {} },
      asAda,
    );
    const notAnObject = await app.call(
      "PATCH",
      "notes.patch",
      { id: 1, changes: "title" },
      asAda,
    );

    expect(missing.status).toBe(400);
    expect(json(missing).details).toEqual([
      { path: ["title"], message: "Required" },
    ]);
    expect(privateField.status).toBe(400);
    expect(JSON.stringify(json(privateField))).not.toContain("secret");
    // Details name the field inside the member it belongs to.
    expect([incomplete.status, json(incomplete).details]).toEqual([
      400,
      [{ path: ["values", "ownerId"], message: "Required" }],
    ]);
    expect([readOnly.status, json(readOnly).details]).toEqual([
      400,
      [{ path: ["changes", "id"], message: "Unknown or read-only field" }],
    ]);
    expect([noChanges.status, json(noChanges).details]).toEqual([
      400,
      [{ path: ["changes"], message: "Expected at least one change" }],
    ]);
    expect([notAnObject.status, json(notAnObject).details]).toEqual([
      400,
      [{ path: ["changes"], message: "Expected a JSON object" }],
    ]);
    // A missing row is a 404 even though the input decoded.
    expect(bigintPatch.status).toBe(404);
    expect(seen).toEqual([{ id: 1, changes: { views: 9007199254740993n } }]);
  });
});

describe("authorization", () => {
  test("a policy without a resource admits only literal true", async () => {
    const decisions: unknown[] = [
      false,
      { deny: "forbidden", reason: SENTINEL.reason },
      { deny: "not-found", reason: SENTINEL.reason },
      "true",
      1,
      {},
      Promise.resolve(false),
      new Error(SENTINEL.error),
    ];
    let next: unknown;
    const execute = vi.fn(() => ({ id: 1, title: "t" }));
    const app = await boot([
      define({
        name: "notes.create",
        entity: "notes",
        method: "POST",
        authorize: () => {
          if (next instanceof Error) throw next;
          return next;
        },
        execute,
      }),
    ]);

    const statuses: number[] = [];
    for (const decision of decisions) {
      next = decision;
      const reply = await app.call(
        "POST",
        "notes.create",
        { title: "t" },
        asAda,
      );
      statuses.push(reply.status);
      expect(reply.body).not.toContain(SENTINEL.reason);
      expect(reply.body).not.toContain(SENTINEL.error);
    }
    expect(statuses).toEqual([403, 403, 404, 403, 403, 403, 403, 403]);
    expect(execute).not.toHaveBeenCalled();

    next = Promise.resolve(true);
    expect(
      (await app.call("POST", "notes.create", { title: "t" }, asAda)).status,
    ).toBe(201);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toContain(SENTINEL.reason);
    expect(logs.join("\n")).not.toContain(SENTINEL.error);
  });

  test("a resource policy loads once, refuses a missing resource, and shares the admitted value", async () => {
    let resource: unknown;
    const lookup = vi.fn(() => resource);
    const allow = vi.fn((ctx: Ctx) => ctx.resource !== "refuse");
    const execute = vi.fn((ctx: Ctx) => ({
      id: 1,
      title: String(ctx.resource),
    }));
    const app = await boot([
      define({
        name: "notes.check",
        entity: "notes",
        method: "PATCH",
        input: z.object({ id: z.number() }),
        output: z.object({ id: z.number(), title: z.string() }),
        authorize: policy({ resource: lookup, allow }),
        execute,
      }),
    ]);
    const call = () => app.call("PATCH", "notes.check", { id: 1 }, asAda);

    const refused: number[] = [];
    for (const value of [null, undefined, "refuse"]) {
      resource = value;
      refused.push((await call()).status);
    }
    lookup.mockImplementationOnce(() => {
      throw new Error(SENTINEL.error);
    });
    refused.push((await call()).status);
    expect(refused).toEqual([404, 404, 404, 404]);
    expect(execute).not.toHaveBeenCalled();
    expect(allow).toHaveBeenCalledTimes(1);

    lookup.mockClear();
    allow.mockClear();
    for (const value of [0, false]) {
      resource = value;
      const reply = await call();
      expect(reply.status).toBe(200);
      expect(json(reply)).toEqual({ id: 1, title: String(value) });
    }
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(allow.mock.calls.map(([ctx]) => ctx.resource)).toEqual([0, false]);
    expect(execute.mock.calls.map(([ctx]) => ctx.resource)).toEqual([0, false]);
  });

  test("callbacks receive the verified actor and services, never the request or its token", async () => {
    const get = ownedNoteGet();
    const app = await boot([get.operation]);
    const note = await seedNote(app.db());

    await app.call("GET", "notes.get", { id: note.id }, asAda);

    const [lookupCtx] = get.spies.lookup.mock.calls[0];
    const [executeCtx] = get.spies.execute.mock.calls[0];
    expect(Object.keys(lookupCtx).sort()).toEqual([
      "actor",
      "appkit",
      "db",
      "input",
    ]);
    expect(Object.keys(executeCtx).sort()).toEqual([
      "actor",
      "appkit",
      "db",
      "input",
      "resource",
    ]);
    expect(executeCtx.actor).toEqual(ADA);
    expect(Object.isFrozen(executeCtx.actor)).toBe(true);
    expect(executeCtx.resource).toBe(get.spies.allow.mock.calls[0][0].resource);
    expect(
      stringify({ ...executeCtx, db: undefined, appkit: undefined }),
    ).not.toContain(SENTINEL.token);
  });
});

describe("execution and output", () => {
  test("default replies project public columns and answer missing rows with 404", async () => {
    const owned = (
      method: string,
      name: string,
      execute: (ctx: Ctx) => unknown,
    ) =>
      define({ name, entity: "notes", method, authorize: () => true, execute });
    const get = ownedNoteGet();
    const app = await boot([
      get.operation,
      owned("POST", "notes.create", ({ db, input, actor }) =>
        db.notes.create({ ...input, ownerId: actor.id, secret: SENTINEL.row }),
      ),
      owned("PATCH", "notes.patch", ({ db, input }) =>
        db.notes.update(input.id, input.changes),
      ),
      owned("PUT", "notes.put", ({ db, input }) =>
        db.notes.update(input.id, input.values),
      ),
      owned("DELETE", "notes.delete", ({ db, input }) =>
        db.notes.delete(input.id),
      ),
    ]);

    const created = await app.call(
      "POST",
      "notes.create",
      { title: "first", views: "9007199254740993" },
      asAda,
    );
    expect(created.status).toBe(201);
    const row = json(created);
    expect(row).toEqual({
      id: row.id,
      title: "first",
      ownerId: SENTINEL.actorId,
      views: "9007199254740993",
    });

    const read = await app.call("GET", "notes.get", { id: row.id }, asAda);
    expect(json(read)).toEqual(row);
    expect(read.body).not.toContain("hidden");

    const patched = await app.call(
      "PATCH",
      "notes.patch",
      { id: row.id, changes: { title: "second" } },
      asAda,
    );
    expect([patched.status, json(patched).title]).toEqual([200, "second"]);
    const put = await app.call(
      "PUT",
      "notes.put",
      { id: row.id, values: { title: "third", ownerId: null, views: null } },
      asAda,
    );
    expect([put.status, json(put).title, json(put).views]).toEqual([
      200,
      "third",
      null,
    ]);
    expect(
      (
        await app.call(
          "PATCH",
          "notes.patch",
          { id: 999, changes: { title: "x" } },
          asAda,
        )
      ).status,
    ).toBe(404);

    const deleted = await app.call(
      "DELETE",
      "notes.delete",
      { id: row.id },
      asAda,
    );
    expect([deleted.status, deleted.body]).toEqual([204, ""]);
    expect(deleted.headers["cache-control"]).toBe("no-store");
    expect(
      (await app.call("DELETE", "notes.delete", { id: row.id }, asAda)).status,
    ).toBe(404);
    expect(app.database.committed.notes).toEqual([]);
  });

  test("custom schemas decode input and validate the reply, with null only where the output accepts it", async () => {
    const app = await boot([
      define({
        name: "notes.search",
        entity: "notes",
        method: "GET",
        input: z.object({
          term: z.string().transform((term) => term.toUpperCase()),
        }),
        output: z.object({ term: z.string() }).nullable(),
        authorize: () => true,
        execute: ({ input }: Ctx) =>
          input.term === "NONE" ? null : { term: input.term },
      }),
      define({
        name: "notes.summary",
        entity: "notes",
        method: "GET",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        authorize: () => true,
        execute: () => null,
      }),
      define({
        name: "notes.broken",
        entity: "notes",
        method: "POST",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        authorize: () => true,
        execute: () => ({ count: SENTINEL.row }),
      }),
      define({
        name: "notes.purge",
        entity: "notes",
        method: "DELETE",
        input: z.object({}),
        output: z.void(),
        authorize: () => true,
        execute: () => undefined,
      }),
    ]);

    const found = await app.call("GET", "notes.search", { term: "abc" }, asAda);
    const none = await app.call("GET", "notes.search", { term: "none" }, asAda);
    const invalid = await app.call("GET", "notes.search", { term: 1 }, asAda);
    const missing = await app.call("GET", "notes.summary", {}, asAda);
    const broken = await app.call("POST", "notes.broken", {}, asAda);
    const purged = await app.call("DELETE", "notes.purge", {}, asAda);

    expect([found.status, json(found)]).toEqual([200, { term: "ABC" }]);
    expect([none.status, none.body]).toEqual([200, "null"]);
    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
    // The write ran before its answer failed, so it may have committed.
    expect([broken.status, json(broken)]).toEqual([
      500,
      { error: "Database write may have completed", outcome: "unknown" },
    ]);
    expect([purged.status, purged.body]).toEqual([204, ""]);
  });

  test("a write whose answer fails after it ran reports an unknown outcome", async () => {
    const app = await boot([
      define({
        name: "notes.rename",
        entity: "notes",
        method: "PATCH",
        authorize: () => true,
        execute: () => null,
      }),
      define({
        name: "notes.drop",
        entity: "notes",
        method: "DELETE",
        authorize: () => true,
        execute: () => "deleted",
      }),
      define({
        name: "notes.peek",
        entity: "notes",
        method: "GET",
        input: z.object({}),
        output: z.object({ count: z.number() }),
        authorize: () => true,
        execute: () => ({ count: SENTINEL.row }),
      }),
    ]);

    const missing = await app.call(
      "PATCH",
      "notes.rename",
      { id: 1, changes: { title: "t" } },
      asAda,
    );
    const malformed = await app.call("DELETE", "notes.drop", { id: 1 }, asAda);
    const read = await app.call("GET", "notes.peek", {}, asAda);

    // A missing row is the contract's definitive answer, not an unknown one.
    expect([missing.status, json(missing)]).toEqual([
      404,
      { error: "Database record not found" },
    ]);
    expect([malformed.status, json(malformed)]).toEqual([
      500,
      { error: "Database write may have completed", outcome: "unknown" },
    ]);
    // A read changed nothing, so its failure stays definitive.
    expect([read.status, json(read)]).toEqual([
      500,
      { error: "Database operation failed" },
    ]);
  });

  test("asynchronous refinements and transforms run on input and output", async () => {
    const execute = vi.fn((ctx: Ctx) => ({
      title: ` ${String(Reflect.get(Object(ctx.input), "title"))} `,
    }));
    const app = await boot([
      define({
        name: "notes.checked",
        entity: "notes",
        method: "POST",
        input: z.object({
          title: z.string().refine(async (title) => title !== "taken"),
        }),
        output: z.object({
          title: z.string().transform(async (title) => title.trim()),
        }),
        authorize: () => true,
        execute,
      }),
    ]);

    const created = await app.call(
      "POST",
      "notes.checked",
      { title: "t" },
      asAda,
    );
    const refused = await app.call(
      "POST",
      "notes.checked",
      { title: "taken" },
      asAda,
    );

    expect([created.status, json(created)]).toEqual([201, { title: "t" }]);
    expect(refused.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("execution failures stay opaque and a write runs once", async () => {
    let failure: unknown;
    const execute = vi.fn(() => {
      throw failure;
    });
    const app = await boot([
      define({
        name: "notes.create",
        entity: "notes",
        method: "POST",
        authorize: () => true,
        execute,
      }),
    ]);

    const replies: Reply[] = [];
    for (const error of [
      new Error(SENTINEL.error),
      new DatabasePluginError("CONFLICT", "write"),
      new DatabasePluginError("TRANSIENT", "write"),
      new DatabasePluginError("UNAUTHENTICATED", "write"),
    ]) {
      failure = error;
      replies.push(
        await app.call("POST", "notes.create", { title: "t" }, asAda),
      );
    }

    expect(replies.map((reply) => reply.status)).toEqual([500, 409, 503, 500]);
    expect(json(replies[0])).toEqual({ error: "Database operation failed" });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(logs.join("\n")).not.toContain(SENTINEL.error);
  });

  test("a note and its event commit together or not at all", async () => {
    const app = await boot([
      define({
        name: "notes.publish",
        entity: "notes",
        method: "POST",
        authorize: () => true,
        execute: ({ db, input, actor }: Ctx) =>
          db.transaction(async (tx: any) => {
            const note = await tx.notes.create({ ...input, ownerId: actor.id });
            await tx.events.create({
              noteId: note.id,
              action: input.title === "fail" ? "explode" : "created",
            });
            return note;
          }),
      }),
    ]);

    const ok = await app.call(
      "POST",
      "notes.publish",
      { title: "kept" },
      asAda,
    );
    const failed = await app.call(
      "POST",
      "notes.publish",
      { title: "fail" },
      asAda,
    );

    expect(ok.status).toBe(201);
    expect(failed.status).toBe(500);
    expect(app.database.committed.notes.map((note) => note.title)).toEqual([
      "kept",
    ]);
    expect(app.database.committed.events).toHaveLength(1);
    expect(app.database.log).toEqual([
      "begin",
      "insert:notes",
      "insert:events",
      "commit",
      "begin",
      "insert:notes",
      "rollback",
    ]);
  });
});

describe("browser origin", () => {
  test("refuses cross-site and same-site browser requests before reading input", async () => {
    const execute = vi.fn(() => ({ id: 1, title: "t" }));
    const get = ownedNoteGet();
    const app = await boot([
      get.operation,
      define({
        name: "notes.create",
        entity: "notes",
        method: "POST",
        authorize: () => true,
        execute,
      }),
    ]);
    const note = await seedNote(app.db());
    const host = new URL(app.url).host;
    const write = (headers: Record<string, string>) =>
      app.call(
        "POST",
        "notes.create",
        { title: "t" },
        { ...asAda, ...headers },
      );

    const refused = [
      await write({ "sec-fetch-site": "cross-site" }),
      await write({ "sec-fetch-site": "same-site" }),
      await write({ "sec-fetch-site": "none" }),
      await write({ origin: "https://attacker.example" }),
      await write({ origin: "null" }),
      await app.call(
        "GET",
        "notes.get",
        { id: note.id },
        { ...asAda, "sec-fetch-site": "cross-site" },
      ),
    ];
    expect(refused.map((reply) => reply.status)).toEqual([
      403, 403, 403, 403, 403, 403,
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(get.spies.lookup).not.toHaveBeenCalled();

    expect((await write({ "sec-fetch-site": "same-origin" })).status).toBe(201);
    expect((await write({ origin: `http://${host}` })).status).toBe(201);
    expect(
      (
        await app.call(
          "GET",
          "notes.get",
          { id: note.id },
          { ...asAda, "sec-fetch-site": "none" },
        )
      ).status,
    ).toBe(200);
  });
});

describe("telemetry", () => {
  test("operation spans carry bounded metadata and lower spans are suppressed", async () => {
    const get = ownedNoteGet();
    const app = await boot([
      get.operation,
      define({
        name: "notes.create",
        entity: "notes",
        method: "POST",
        authorize: policy({
          allow: () => ({ deny: "forbidden", reason: SENTINEL.reason }),
        }),
        execute: () => null,
      }),
      define({
        name: "notes.explode",
        entity: "notes",
        method: "POST",
        authorize: () => true,
        execute: ({ db }: Ctx) =>
          db.notes.create({ title: "explode", secret: SENTINEL.row }),
      }),
    ]);
    const note = await seedNote(app.db());
    // The control: the same lower span outside an operation is exported.
    expect(
      stringify(exporter.getFinishedSpans().map((span) => span.attributes)),
    ).toContain(SENTINEL.row);
    exporter.reset();

    await app.call("GET", "notes.get", { id: note.id }, asAda);
    await app.call("GET", "notes.get", { id: SENTINEL.input }, asAda);
    await app.call("POST", "notes.create", { title: SENTINEL.input }, asAda);
    await app.call("POST", "notes.explode", { title: SENTINEL.input }, asAda);
    await app.call(
      "GET",
      "notes.get",
      { id: 1 },
      { "x-forwarded-access-token": "token-forged" },
    );

    // The fake workspace runs in-process; its server spans are the workspace's, not the app's.
    const workspaceHost = new URL(workspace.url).host;
    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes["http.host"] !== workspaceHost);
    const operationSpans = spans.filter(
      (span) => span.name === "database.operation",
    );
    const serverSpans = spans.filter((span) => span.kind === SpanKind.SERVER);
    // Only the request span and the operation span: every lower span was suppressed.
    expect(spans).toHaveLength(10);
    expect(serverSpans.map((span) => span.name)).toEqual([
      "GET /api/database/operations/notes.get",
      "GET /api/database/operations/notes.get",
      "POST /api/database/operations/notes.create",
      "POST /api/database/operations/notes.explode",
      "GET /api/database/operations/notes.get",
    ]);
    expect(serverSpans[1].attributes["http.target"]).toBe(
      "/api/database/operations/notes.get",
    );
    expect(serverSpans[1].attributes["http.url"]).toBe(
      `${app.url}/api/database/operations/notes.get`,
    );
    expect(operationSpans.map((span) => span.attributes)).toEqual([
      expect.objectContaining({
        "database.operation.name": "notes.get",
        "database.operation.outcome": "success",
        "http.response.status_code": 200,
      }),
      expect.objectContaining({
        "database.operation.outcome": "INVALID_REQUEST",
        "database.operation.stage": "input",
      }),
      expect.objectContaining({
        "database.operation.name": "notes.create",
        "database.operation.outcome": "FORBIDDEN",
        "database.operation.stage": "allow",
      }),
      expect.objectContaining({
        "database.operation.name": "notes.explode",
        "database.operation.outcome": "INTERNAL",
        "database.operation.stage": "execute",
      }),
      expect.objectContaining({
        "database.operation.outcome": "UNAUTHENTICATED",
        "database.operation.stage": "actor",
      }),
    ]);
    const exported = JSON.stringify(
      spans.map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    for (const value of Object.values(SENTINEL)) {
      expect(exported).not.toContain(value);
      expect(logs.join("\n")).not.toContain(value);
    }
    expect(exported).not.toContain(discriminator(SENTINEL.actorId));
  });
});

describe("local development boundary", () => {
  test("serves only the signed-in developer, on a same-origin loopback request", async () => {
    const identity = vi.fn(async () => ({
      token: "local-token",
      userId: "dev-user-1",
      email: "dev@example.com",
    }));
    const execute = vi.fn((ctx: Ctx) => ({ term: ctx.actor.id }));
    const app = await boot(
      [
        define({
          name: "me.get",
          entity: "notes",
          method: "GET",
          input: z.object({}),
          output: z.object({ term: z.string() }),
          authorize: () => true,
          execute,
        }),
      ],
      {
        resolveActor: createActorResolver({
          kind: "local",
          host: "https://dev.example",
          identity,
        }),
      },
    );
    const target = `${app.url}/api/database/operations/me.get?input=%7B%7D`;
    const host = new URL(app.url).host;

    const ok = await send(target, {
      headers: {
        "x-forwarded-access-token": SENTINEL.token,
        "x-forwarded-user": "someone-else",
      },
    });
    const foreignHost = await send(target, {
      headers: { host: `localhost.attacker.example:${new URL(app.url).port}` },
    });
    const foreignOrigin = await send(target, {
      headers: { host, origin: "http://evil.example" },
    });
    identity.mockRejectedValueOnce(new Error(SENTINEL.error));
    const signedOut = await send(target, { headers: { host } });

    expect([ok.status, json(ok)]).toEqual([200, { term: "dev-user-1" }]);
    expect(ok.headers["x-appkit-database-actor"]).toBe(
      createHash("sha256")
        .update("https://dev.example\0dev-user-1")
        .digest("hex"),
    );
    expect([
      foreignHost.status,
      foreignOrigin.status,
      signedOut.status,
    ]).toEqual([401, 401, 401]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(workspace.authorizations).toEqual([]);
    expect(logs.join("\n")).not.toContain(SENTINEL.error);
  });

  test("an unsupported deployment authenticates no one", async () => {
    const get = ownedNoteGet();
    const app = await boot([get.operation], {
      resolveActor: createActorResolver({ kind: "unsupported" }),
    });

    const reply = await app.call("GET", "notes.get", { id: 1 }, asAda);

    expect(reply.status).toBe(401);
    expect(workspace.authorizations).toEqual([]);
    expect(get.spies.lookup).not.toHaveBeenCalled();
  });
});

describe("setup", () => {
  const handler =
    (
      operation: Record<string, unknown>,
      extra: Record<string, unknown>[] = [],
    ) =>
    () => {
      const { operations } = validateOperationMetadata(
        [operation, ...extra].map((value, index) => ({
          file: "routes.ts",
          exportName: `op${index}`,
          value: define(value),
        })),
        new Set(Object.keys(schema.$tables)),
      );
      return createOperationHandler({
        schema,
        operations,
        resolveActor: createActorResolver({ kind: "unsupported" }),
        services: () => {
          throw new Error("unused");
        },
        telemetry: TelemetryManager.getProvider("database"),
      });
    };
  const base = { authorize: () => true, execute: () => null };

  test("refuses a default contract the table cannot honor", () => {
    expect(
      handler({ ...base, name: "tags.get", entity: "tags", method: "GET" }),
    ).toThrow(/routes\.ts#op0 needs an explicit input/);
    expect(
      handler({
        ...base,
        name: "stamps.patch",
        entity: "stamps",
        method: "PATCH",
      }),
    ).toThrow(/needs an explicit input/);
    expect(
      handler({ ...base, name: "stamps.put", entity: "stamps", method: "PUT" }),
    ).toThrow(/needs an explicit input/);
    expect(
      handler({
        ...base,
        name: "tags.find",
        entity: "tags",
        method: "GET",
        input: z.object({ label: z.string() }),
      }),
    ).not.toThrow();
  });
});
