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
import { MAX_RESPONSE_BYTES } from "../../defaults";
import type { EntityClient } from "../../entity-client";
import type { ReadSerializer } from "../../types";
import { type CrudTable, compileCrudTables } from "../contract";
import {
  type CrudReadEntity,
  createDetailHandler,
  createListHandler,
  type ReadRouteDeps,
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

// The routes reach their entity through an untyped export lookup, so the read
// surface they drive has to stay a subset of the real client.
const _entityClientSatisfiesReads: CrudReadEntity = {} as EntityClient;

interface FakeEntity extends CrudReadEntity {
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

function deps(
  table: string,
  entity: CrudReadEntity,
  serialize?: ReadSerializer,
): ReadRouteDeps {
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
