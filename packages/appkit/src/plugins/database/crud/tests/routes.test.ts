import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LIMIT } from "../../../../database/contract";
import { DatabasePluginError } from "../../../../database/errors";
import type { Row } from "../../../../database/runtime";
import {
  defineSchema,
  fk,
  id,
  text,
} from "../../../../database/schema-builder";
import { DatabaseValidationError } from "../../../../errors";
import { MAX_RESPONSE_BYTES } from "../../defaults";
import type { EntityClient } from "../../entity-client";
import type { ReadSerializer } from "../../types";
import { type CrudTable, compileCrudTables } from "../contract";
import {
  type CrudEntity,
  type CrudRouteDeps,
  createCreateHandler,
  createDeleteHandler,
  createDetailHandler,
  createListHandler,
  createUpdateHandler,
} from "../routes";

const schema = defineSchema((builder) => {
  const users = builder.table("users", {
    id: id(),
    name: text(),
    token: text().private(),
  });
  const notes = builder.table("notes", {
    id: id(),
    authorId: fk(() => users.id),
    body: text(),
  });
  const events = builder.table("events", { message: text() });
  return { users, notes, events };
});

const tables = compileCrudTables(schema.$tables);

// The routes reach their entity through an untyped export lookup, so the
// surface they drive has to stay a subset of the real client.
const _entityClientSatisfiesRoutes: CrudEntity = {} as EntityClient;

interface FakeEntity extends CrudEntity {
  readonly calls: Record<string, unknown[]>;
}

function fakeEntity(rows: Row[], found: Row | null = null): FakeEntity {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, value: unknown) => {
    calls[name] ??= [];
    calls[name].push(value);
  };
  const chain = (name: string) => (value: unknown) => {
    record(name, value);
    return entity;
  };
  const entity: FakeEntity = {
    calls,
    where: chain("where"),
    order: chain("order"),
    select: chain("select"),
    include: chain("include"),
    limit: chain("limit"),
    offset: chain("offset"),
    toArray: async () => {
      record("toArray", true);
      return rows;
    },
    find: async (value) => {
      record("find", value);
      return found;
    },
    create: async (values) => {
      record("create", values);
      return { id: 1, ...values, token: "secret" };
    },
    update: async (value, values) => {
      record("update", [value, values]);
      return found && { ...found, ...values };
    },
    delete: async (value) => {
      record("delete", value);
      return found !== null;
    },
  };
  return entity;
}

function fakeResponse() {
  const sent: {
    status?: number;
    body?: string;
    type?: string;
    headers: Record<string, string>;
  } = { headers: {} };
  const res = {
    headersSent: false,
    status: vi.fn((code: number) => {
      sent.status = code;
      return res;
    }),
    type: vi.fn((value: string) => {
      sent.type = value;
      return res;
    }),
    setHeader: vi.fn((name: string, value: string) => {
      sent.headers[name] = value;
      return res;
    }),
    send: vi.fn((body: string) => {
      sent.body = body;
      return res;
    }),
  };
  return {
    res: res as unknown as Response,
    sent,
    json: () => JSON.parse(sent.body ?? "null"),
  };
}

function request(url: string, params: Record<string, string> = {}): Request {
  return { originalUrl: url, url, params } as unknown as Request;
}

function writeRequest(
  url: string,
  body: unknown,
  params: Record<string, string> = {},
  contentType: string | null = "application/json",
): Request {
  return {
    originalUrl: url,
    url,
    params,
    body,
    is: (type: string) => contentType?.includes(type.split("/")[1]) ?? false,
  } as unknown as Request;
}

function deps(
  table: string,
  entity: CrudEntity,
  serialize?: ReadSerializer,
): CrudRouteDeps {
  return {
    table: tables.get(table) as CrudTable,
    entity: () => entity,
    serialize,
    runRouteSpan: (_operation, _route, run) => run(),
  };
}

let response = fakeResponse();
beforeEach(() => {
  response = fakeResponse();
});

describe("list route", () => {
  it("returns the bounded envelope from one query", async () => {
    const entity = fakeEntity([
      { id: 1, name: "Ada", token: "secret" },
      { id: 2, name: "Grace", token: "secret" },
    ]);
    await createListHandler(deps("users", entity))(
      request("/users"),
      response.res,
    );

    expect(response.sent.status).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ],
      limit: DEFAULT_LIMIT,
      offset: 0,
    });
    expect(entity.calls.toArray).toHaveLength(1);
    expect(entity.calls.where).toBeUndefined();
    expect(entity.calls.order).toEqual([{ id: "asc" }]);
  });

  it("keeps row data out of shared and browser caches", async () => {
    await createListHandler(deps("users", fakeEntity([])))(
      request("/users"),
      response.res,
    );
    expect(response.sent.headers["Cache-Control"]).toBe("no-store");

    const rejected = fakeResponse();
    await createListHandler(deps("users", fakeEntity([])))(
      request("/users?limit=abc"),
      rejected.res,
    );
    expect(rejected.sent.headers["Cache-Control"]).toBe("no-store");
  });

  it("appends the primary key so equal sort keys stay stable", async () => {
    const entity = fakeEntity([]);
    await createListHandler(deps("users", entity))(
      request(`/users?order=${encodeURIComponent('{"name":"desc"}')}`),
      response.res,
    );
    expect(entity.calls.order).toEqual([{ name: "desc", id: "asc" }]);
  });

  it("keeps a caller-supplied key direction", async () => {
    const entity = fakeEntity([]);
    await createListHandler(deps("users", entity))(
      request(`/users?order=${encodeURIComponent('{"id":"desc"}')}`),
      response.res,
    );
    expect(entity.calls.order).toEqual([{ id: "desc" }]);
  });

  it("requires explicit ordering when a table has no key", async () => {
    const entity = fakeEntity([]);
    await createListHandler(deps("events", entity))(
      request("/events"),
      response.res,
    );
    expect(response.sent.status).toBe(400);
    expect(entity.calls.toArray).toBeUndefined();

    const ordered = fakeEntity([]);
    await createListHandler(deps("events", ordered))(
      request(`/events?order=${encodeURIComponent('{"message":"asc"}')}`),
      fakeResponse().res,
    );
    expect(ordered.calls.order).toEqual([{ message: "asc" }]);
  });

  it("forwards only the parameters the caller supplied", async () => {
    const entity = fakeEntity([]);
    const url = `/notes?where=${encodeURIComponent('{"body":"a"}')}&select=${encodeURIComponent('["body"]')}&include=${encodeURIComponent('{"users":true}')}&limit=5&offset=3`;
    await createListHandler(deps("notes", entity))(request(url), response.res);
    expect(entity.calls).toMatchObject({
      where: [{ body: "a" }],
      select: [["body"]],
      include: [{ users: true }],
      limit: [5],
      offset: [3],
    });
  });

  it("rejects an invalid query before touching the entity", async () => {
    const entity = fakeEntity([]);
    await createListHandler(deps("users", entity))(
      request("/users?limit=abc"),
      response.res,
    );
    expect(response.sent.status).toBe(400);
    expect(response.json()).toEqual({
      error: "Invalid database request",
      details: [{ path: ["limit"], message: expect.any(String) }],
    });
    expect(entity.calls.toArray).toBeUndefined();
  });
});

describe("detail route", () => {
  it("returns one public row for a decoded key", async () => {
    const entity = fakeEntity([], { id: 7, name: "Ada", token: "secret" });
    await createDetailHandler(deps("users", entity))(
      request("/users/7", { id: "7" }),
      response.res,
    );
    expect(entity.calls.find).toEqual([7]);
    expect(response.json()).toEqual({ id: 7, name: "Ada" });
  });

  it("answers a missing row with 404 and no internal category", async () => {
    const entity = fakeEntity([], null);
    await createDetailHandler(deps("users", entity))(
      request("/users/7", { id: "7" }),
      response.res,
    );
    expect(response.sent.status).toBe(404);
    expect(response.json()).toEqual({ error: "Database record not found" });
  });

  it("rejects an unrepresentable key without a lookup", async () => {
    const entity = fakeEntity([], null);
    await createDetailHandler(deps("users", entity))(
      request("/users/abc", { id: "abc" }),
      response.res,
    );
    expect(response.sent.status).toBe(400);
    expect(entity.calls.find).toBeUndefined();
  });
});

describe("serialization and response limits", () => {
  it("keeps the serializer contract synchronous", () => {
    // @ts-expect-error a serializer may not defer work into the response path
    const deferred: ReadSerializer = async (row) => row;
    expect(deferred).toBeTypeOf("function");
  });

  it("applies a synchronous serializer and re-checks private columns", async () => {
    const serialize = vi.fn<ReadSerializer>((row) => ({
      ...row,
      label: `#${row.id}`,
      token: "reintroduced",
    }));
    const entity = fakeEntity([{ id: 1, name: "Ada", token: "secret" }]);
    await createListHandler(deps("users", entity, serialize))(
      request("/users"),
      response.res,
    );
    expect(serialize).toHaveBeenCalledWith(
      { id: 1, name: "Ada" },
      { entity: "users", operation: "list" },
    );
    expect(response.json().items).toEqual([
      { id: 1, name: "Ada", label: "#1" },
    ]);
  });

  it("maps a broken serializer to an opaque server error", async () => {
    const entity = fakeEntity([{ id: 1, name: "Ada" }]);
    const throwing = vi.fn<ReadSerializer>(() => {
      throw new Error("boom: select * from users");
    });
    await createListHandler(deps("users", entity, throwing))(
      request("/users"),
      response.res,
    );
    expect(response.sent.status).toBe(500);
    expect(response.json()).toEqual({ error: "Database operation failed" });
  });

  it("rejects a response that exceeds the byte budget", async () => {
    const wide = "x".repeat(1024 * 1024);
    const entity = fakeEntity(
      Array.from({ length: 6 }, (_, index) => ({ id: index, name: wide })),
    );
    await createListHandler(deps("users", entity))(
      request("/users"),
      response.res,
    );
    expect(response.sent.status).toBe(413);
    expect(response.json()).toEqual({
      error: "Database response is too large",
    });
    expect(MAX_RESPONSE_BYTES).toBeLessThan(6 * wide.length);
  });

  it("stops shaping rows once the byte budget is exceeded", async () => {
    const wide = "x".repeat(2 * 1024 * 1024);
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: index,
      name: wide,
    }));
    const serialize = vi.fn<ReadSerializer>((row) => row);
    await createListHandler(deps("users", fakeEntity(rows), serialize))(
      request("/users"),
      response.res,
    );
    expect(response.sent.status).toBe(413);
    // Rows past the budget are never projected, serialized, or encoded.
    expect(serialize.mock.calls.length).toBeLessThan(rows.length);
  });

  it("maps an entity failure to its safe category", async () => {
    const entity = fakeEntity([]);
    entity.toArray = async () => {
      throw new DatabasePluginError("FORBIDDEN", "read");
    };
    await createListHandler(deps("users", entity))(
      request("/users"),
      response.res,
    );
    expect(response.sent.status).toBe(403);
    expect(response.json()).toEqual({
      error: "Database operation forbidden",
    });
  });
});

describe("write routes", () => {
  it("creates a row at 201 and returns only its public columns", async () => {
    const entity = fakeEntity([]);
    await createCreateHandler(deps("users", entity))(
      writeRequest("/users", { name: "Ada" }),
      response.res,
    );
    expect(entity.calls.create).toEqual([{ name: "Ada" }]);
    expect(response.sent.status).toBe(201);
    expect(response.json()).toEqual({ id: 1, name: "Ada" });
    expect(response.sent.headers["Cache-Control"]).toBe("no-store");
  });

  it("never reshapes a mutation response with a read serializer", async () => {
    const serialize = vi.fn<ReadSerializer>((row) => ({ ...row, extra: true }));
    const entity = fakeEntity([]);
    await createCreateHandler(deps("users", entity, serialize))(
      writeRequest("/users", { name: "Ada" }),
      response.res,
    );
    expect(serialize).not.toHaveBeenCalled();
    expect(response.json()).toEqual({ id: 1, name: "Ada" });
  });

  it("updates a row at 200 and deletes one at 204", async () => {
    const entity = fakeEntity([], { id: 7, name: "Ada", token: "secret" });
    await createUpdateHandler(deps("users", entity))(
      writeRequest("/users/7", { name: "Grace" }, { id: "7" }),
      response.res,
    );
    expect(entity.calls.update).toEqual([[7, { name: "Grace" }]]);
    expect(response.sent.status).toBe(200);
    expect(response.json()).toEqual({ id: 7, name: "Grace" });

    const removed = fakeResponse();
    await createDeleteHandler(deps("users", entity))(
      request("/users/7", { id: "7" }),
      removed.res,
    );
    expect(entity.calls.delete).toEqual([7]);
    expect(removed.sent.status).toBe(204);
    expect(removed.sent.body).toBeUndefined();
  });

  it("answers 404 when an update or delete matches nothing", async () => {
    const entity = fakeEntity([], null);
    await createUpdateHandler(deps("users", entity))(
      writeRequest("/users/7", { name: "Grace" }, { id: "7" }),
      response.res,
    );
    expect(response.sent.status).toBe(404);
    expect(response.json()).toEqual({ error: "Database record not found" });

    const removed = fakeResponse();
    await createDeleteHandler(deps("users", entity))(
      request("/users/7", { id: "7" }),
      removed.res,
    );
    expect(removed.sent.status).toBe(404);
  });

  it("requires a JSON body and refuses query parameters", async () => {
    const entity = fakeEntity([]);
    await createCreateHandler(deps("users", entity))(
      writeRequest("/users", "name=Ada", {}, "text/plain"),
      response.res,
    );
    expect(response.sent.status).toBe(415);
    expect(response.json()).toEqual({
      error: "Database request body must be JSON",
    });

    const filtered = fakeResponse();
    await createCreateHandler(deps("users", entity))(
      writeRequest("/users?where=x", { name: "Ada" }),
      filtered.res,
    );
    expect(filtered.sent.status).toBe(400);
    expect(filtered.json().details).toEqual([
      { path: ["query"], message: expect.any(String) },
    ]);

    const patched = fakeResponse();
    await createUpdateHandler(deps("users", entity))(
      writeRequest("/users/7?where=x", { name: "Ada" }, { id: "7" }),
      patched.res,
    );
    expect(patched.sent.status).toBe(400);

    const onDelete = fakeResponse();
    await createDeleteHandler(deps("users", entity))(
      request("/users/7?cascade=true", { id: "7" }),
      onDelete.res,
    );
    expect(onDelete.sent.status).toBe(400);
    expect(entity.calls.create).toBeUndefined();
    expect(entity.calls.update).toBeUndefined();
    expect(entity.calls.delete).toBeUndefined();
  });

  it("names a public column the caller may not write", async () => {
    const entity = fakeEntity([]);
    await createCreateHandler(deps("users", entity))(
      writeRequest("/users", { name: "Ada", id: 7 }),
      response.res,
    );
    expect(response.sent.status).toBe(400);
    expect(response.json()).toEqual({
      error: "Invalid database request",
      details: [{ path: ["id"], message: expect.any(String) }],
    });
    expect(entity.calls.create).toBeUndefined();
  });

  it.each([
    ["a private column", { token: "stolen" }, "stolen"],
    ["caller markup", { "<script>alert(1)</script>": 1 }, "<script>"],
  ])("answers %s without repeating it", async (_case, body, secret) => {
    const entity = fakeEntity([]);
    await createCreateHandler(deps("users", entity))(
      writeRequest("/users", body),
      response.res,
    );
    expect(response.sent.status).toBe(400);
    expect(response.json()).toEqual({
      error: "Invalid database request",
      details: [{ path: ["body"], message: expect.any(String) }],
    });
    expect(response.sent.body).not.toContain(secret);
    expect(entity.calls.create).toBeUndefined();
  });

  it("answers a hook's validation failure with 422 and its public issues", async () => {
    const entity = fakeEntity([]);
    entity.create = async () => {
      throw new DatabaseValidationError("rejected", [
        { path: ["name"], message: "must not be empty" },
        { path: ["token"], message: "leaks a private column" },
        { path: ["internalRule"], message: "leaks an internal rule" },
      ]);
    };
    await createCreateHandler(deps("users", entity))(
      writeRequest("/users", { name: "" }),
      response.res,
    );
    expect(response.sent.status).toBe(422);
    expect(response.json()).toEqual({
      error: "Database request failed validation",
      details: [{ path: ["name"], message: "must not be empty" }],
    });
    expect(response.sent.body).not.toContain("token");
    expect(response.sent.body).not.toContain("internalRule");
  });

  it("drops issues a failure cannot afford to carry", async () => {
    const entity = fakeEntity([]);
    entity.create = async () => {
      throw new DatabaseValidationError("rejected", [
        { path: ["name"], message: "x".repeat(MAX_RESPONSE_BYTES) },
      ]);
    };
    await createCreateHandler(deps("users", entity))(
      writeRequest("/users", { name: "Ada" }),
      response.res,
    );
    expect(response.sent.status).toBe(422);
    expect(response.json()).toEqual({
      error: "Database request failed validation",
    });
    expect(Buffer.byteLength(response.sent.body ?? "", "utf8")).toBeLessThan(
      MAX_RESPONSE_BYTES,
    );
  });

  it("keeps a failed write opaque", async () => {
    const entity = fakeEntity([]);
    entity.create = async () => {
      throw new Error('duplicate key value violates "users_pkey"');
    };
    await createCreateHandler(deps("users", entity))(
      writeRequest("/users", { name: "Ada" }),
      response.res,
    );
    expect(response.sent.status).toBe(500);
    expect(response.json()).toEqual({ error: "Database operation failed" });
  });
});
