import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMockTelemetry, mockServiceContext } from "@tools/test-helpers";
import type { Request, RequestHandler, Response } from "express";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import type { DataPath } from "../../../database/runtime";
import { defineSchema, id, text } from "../../../database/schema-builder";
import type { ITelemetry } from "../../../telemetry";
import type { DatabaseExports } from "../entity-types";
import {
  defineMutation,
  definePolicy,
  defineQuery,
  loadDefaultDatabaseRoutes,
  type OperationError,
  operationErrorResponse,
  runOperation,
} from "../operations";
import type { IDatabaseConfig } from "../types";

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

const alice = { userId: "alice" };

/** A transaction that restores the state it started from when its callback throws. */
function fakeDb(state: { value: number }) {
  const db = {
    sql: vi.fn(async () => []),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const before = state.value;
      try {
        return await callback(db);
      } catch (error) {
        state.value = before;
        throw error;
      }
    },
  };
  return db as unknown as DatabaseExports & { sql: ReturnType<typeof vi.fn> };
}

async function failure(promise: Promise<unknown>): Promise<OperationError> {
  try {
    await promise;
  } catch (error) {
    return error as OperationError;
  }
  throw new Error("expected the operation to fail");
}

describe("runOperation", () => {
  const state = { value: 0 };
  const execute = vi.fn(async () => {
    state.value += 1;
    return { value: state.value };
  });
  const increment = (
    authorize: Parameters<typeof defineMutation>[0]["authorize"],
  ) =>
    defineMutation({ input: z.object({ by: z.number() }), authorize, execute });

  beforeEach(() => {
    state.value = 0;
    execute.mockClear();
  });

  test("runs an authorized operation and returns its typed result", async () => {
    const op = increment(() => true);
    await expect(
      runOperation(op, { actor: alice, input: { by: 1 } }, fakeDb(state)),
    ).resolves.toEqual({ value: 1 });
  });

  test("rejects a missing actor before validation or authorization", async () => {
    const authorize = vi.fn(() => true);
    const error = await failure(
      runOperation(
        increment(authorize),
        { actor: undefined, input: { by: 1 } },
        fakeDb(state),
      ),
    );
    expect(error.statusCode).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects invalid input before authorization or execution", async () => {
    const authorize = vi.fn(() => true);
    const error = await failure(
      runOperation(
        increment(authorize),
        { actor: alice, input: { by: "1" } },
        fakeDb(state),
      ),
    );
    expect(error.statusCode).toBe(400);
    expect(error.details?.[0].path).toBe("by");
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test.each([
    [false, "Forbidden"],
    [{ deny: "Not on this team" }, "Not on this team"],
  ])("refuses with 403 when a policy returns %j", async (result, message) => {
    const error = await failure(
      runOperation(
        increment(() => result),
        { actor: alice, input: { by: 1 } },
        fakeDb(state),
      ),
    );
    expect([error.statusCode, error.clientMessage]).toEqual([403, message]);
    expect(state.value).toBe(0);
  });

  test("requires every policy in an array to allow", async () => {
    const second = vi.fn(() => true);
    const error = await failure(
      runOperation(
        increment([() => ({ deny: "no" }), second]),
        { actor: alice, input: { by: 1 } },
        fakeDb(state),
      ),
    );
    expect(error.statusCode).toBe(403);
    expect(second).not.toHaveBeenCalled();
  });

  test.each([
    ["a thrown lookup", () => Promise.reject(new Error("password=hunter2"))],
    ["a forgotten return", () => undefined as never],
    ["a truthy non-decision", () => ({ ok: true }) as never],
  ])("treats %s as a 500, never an allow", async (_name, policy) => {
    const error = await failure(
      runOperation(
        increment(policy),
        { actor: alice, input: { by: 1 } },
        fakeDb(state),
      ),
    );
    expect([error.statusCode, error.clientMessage]).toEqual([
      500,
      "Authorization check failed",
    ]);
    expect(JSON.stringify(operationErrorResponse(error))).not.toContain(
      "hunter2",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test("rolls back a mutation whose execution fails after writing", async () => {
    const op = defineMutation({
      input: z.object({}),
      authorize: () => true,
      execute: async () => {
        state.value = 99;
        throw new Error("boom");
      },
    });
    await expect(
      runOperation(op, { actor: alice, input: {} }, fakeDb(state)),
    ).rejects.toThrow("boom");
    expect(state.value).toBe(0);
  });

  test("reports an unknown failure without its message", () => {
    const response = operationErrorResponse(
      new Error("connect postgres://sp:token@host failed"),
    );
    expect(response).toEqual({
      status: 500,
      body: { error: "Operation failed" },
    });
  });

  test("refuses to define or run an operation without authorization", async () => {
    expect(() =>
      defineQuery({
        input: z.object({}),
        authorize: [],
        execute: async () => 1,
      }),
    ).toThrow(/requires authorize/);
    const forged = {
      kind: "query",
      input: z.object({}),
      authorize: () => true,
      execute: async () => 1,
    } as never;
    const error = await failure(
      runOperation(forged, { actor: alice, input: {} }, fakeDb(state)),
    );
    expect(error.statusCode).toBe(500);
  });

  test("definePolicy keeps the policy callable as-is", () => {
    const policy = definePolicy<{ teamId: string }>(() => true);
    expect(
      policy({ actor: alice, input: { teamId: "x" }, db: {} as never }),
    ).toBe(true);
  });
});

describe("loadDefaultDatabaseRoutes", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "appkit-routes-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns no routes when the folder is missing", async () => {
    await expect(loadDefaultDatabaseRoutes(root)).resolves.toEqual({});
  });

  test("merges default exports and rejects a repeated route", async () => {
    const dir = path.join(root, "config/database/routes");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "a.ts"), 'export default { "GET /a": 1 };');
    await writeFile(path.join(dir, "b.ts"), 'export default { "GET /b": 2 };');
    await expect(loadDefaultDatabaseRoutes(root)).resolves.toEqual({
      "GET /a": 1,
      "GET /b": 2,
    });
    await writeFile(path.join(dir, "c.ts"), 'export default { "GET /a": 3 };');
    await expect(loadDefaultDatabaseRoutes(root)).rejects.toThrow(
      /declared more than once/,
    );
  });
});

const schema = defineSchema((builder) => ({
  notes: builder.table("notes", { id: id(), body: text().notNull() }),
}));

const seen = vi.fn();
const echo = defineMutation({
  input: z.object({ id: z.string(), actorId: z.string().optional() }),
  authorize: ({ actor }) => actor.userId === "alice" || { deny: "Only alice" },
  execute: async ({ actor, input }) => {
    seen(actor, input);
    return { id: input.id, by: actor.userId };
  },
});

async function mount(config: Omit<IDatabaseConfig<typeof schema>, "schema">) {
  const path = {
    raw: async () => [],
    transaction: async (callback: (tx: DataPath) => Promise<unknown>) =>
      callback(path),
  } as unknown as DataPath;
  mocks.initializeLakebasePool.mockResolvedValue({
    end: vi.fn(async () => undefined),
  });
  mocks.createDrizzleDb.mockReturnValue({});
  mocks.createDrizzleDataPath.mockReturnValue(path);
  const plugin = new DatabasePlugin({ schema, ...config });
  (plugin as unknown as { telemetry: ITelemetry }).telemetry =
    createMockTelemetry();
  await plugin.setup();
  const handlers = new Map<string, RequestHandler>();
  const record = (method: string) => (route: string, handler: RequestHandler) =>
    handlers.set(`${method} ${route}`, handler);
  plugin.injectRoutes({
    get: record("get"),
    post: record("post"),
    patch: record("patch"),
    delete: record("delete"),
  } as never);
  return handlers;
}

async function call(
  handler: RequestHandler | undefined,
  req: { headers?: Record<string, string>; params?: object; body?: object },
) {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return res;
    },
    setHeader: () => res,
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  const headers = req.headers ?? {};
  await (handler as unknown as (req: Request, res: Response) => Promise<void>)(
    {
      params: req.params ?? {},
      body: req.body,
      query: {},
      header: (name: string) => headers[name],
    } as unknown as Request,
    res as unknown as Response,
  );
  return sent;
}

describe("database routes", () => {
  let context: Awaited<ReturnType<typeof mockServiceContext>>;
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "production");
    seen.mockClear();
    context = await mockServiceContext();
  });
  afterEach(() => {
    context.restore();
    vi.unstubAllEnvs();
  });

  test("serves an operation with the actor from the proxy header, not the body", async () => {
    const handlers = await mount({
      api: false,
      routes: { "POST /notes/:id/echo": echo },
    });
    const sent = await call(handlers.get("post /notes/:id/echo"), {
      headers: { "x-forwarded-user": "alice" },
      params: { id: "7" },
      // Neither a body id nor a body identity can replace the trusted ones.
      body: { id: "8", userId: "mallory", actorId: "mallory" },
    });
    expect(sent).toEqual({ status: 200, body: { id: "7", by: "alice" } });
  });

  test("answers 401 without the proxy header and 403 for a refused actor", async () => {
    const handlers = await mount({
      api: false,
      routes: { "POST /notes/:id/echo": echo },
    });
    const handler = handlers.get("post /notes/:id/echo");
    expect(await call(handler, { params: { id: "7" } })).toEqual({
      status: 401,
      body: { error: "Authentication required" },
    });
    expect(
      await call(handler, {
        headers: { "x-forwarded-user": "bob" },
        params: { id: "7" },
      }),
    ).toEqual({ status: 403, body: { error: "Only alice" } });
    expect(seen).not.toHaveBeenCalled();
  });

  test.each(["GET /notes/:noteId", "GET /Notes", "GET /notes/"])(
    "fails setup when %s overlaps generated CRUD",
    async (key) => {
      await expect(mount({ routes: { [key]: echo } })).rejects.toThrow(
        /collides/,
      );
    },
  );

  test("fails setup for routes Express treats as one", async () => {
    await expect(
      mount({
        api: false,
        routes: { "GET /status": echo, "GET /STATUS/": echo },
      }),
    ).rejects.toThrow(/collides/);
  });

  test("fails setup for a malformed key or a value that is not an operation", async () => {
    await expect(
      mount({ api: false, routes: { "/notes": echo } }),
    ).rejects.toThrow(/must look like/);
    await expect(
      mount({
        api: false,
        routes: { "GET /x": { execute: () => 1 } as never },
      }),
    ).rejects.toThrow(/must map to an operation/);
  });
});
