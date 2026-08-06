import { describe, expect, test, vi } from "vitest";
import { MAX_LIMIT } from "../../../database/contract";
import type {
  DataPath,
  QuerySpec,
  Row,
  WhereClause,
} from "../../../database/runtime";
import { defineSchema, id, text } from "../../../database/schema-builder";
import { EntityClient, type EntityClientContext } from "../entity-client";

const schema = defineSchema(({ table }) => {
  const notes = table("notes", { id: id(), body: text().notNull() });
  return { notes };
});

function harness() {
  const calls: Array<[string, unknown]> = [];
  const dataPath: DataPath = {
    select: async (_table, spec) => {
      calls.push(["select", spec]);
      return [{ id: 1, body: "a" }];
    },
    findOne: async (_table, _id, spec) => {
      calls.push(["findOne", spec]);
      return { id: 1, body: "a" };
    },
    count: async (_table, where) => {
      calls.push(["count", where]);
      return 1;
    },
    insert: async (_table, values) => {
      calls.push(["insert", values]);
      return { id: 1, ...values };
    },
    update: async (_table, _id, values) => {
      calls.push(["update", values]);
      return { id: 1, ...values };
    },
    upsert: async (_table, values, target) => {
      calls.push(["upsert", target]);
      return { id: 1, ...values };
    },
    delete: async () => {
      calls.push(["delete", undefined]);
      return true;
    },
    raw: async () => [],
    transaction: async (callback) => callback(dataPath),
  };
  const context: EntityClientContext = {
    table: schema.$tables.notes,
    getDataPath: () => dataPath,
    assertActive: vi.fn(),
    execute: async (operation) => ({ ok: true, data: await operation() }),
  };
  return { client: new EntityClient(context), calls };
}

describe("EntityClient", () => {
  test("retains accumulated predicates in find", async () => {
    const { client, calls } = harness();
    const filter = { body: { eq: "a" } } as WhereClause;
    await client.where(filter).find(1);
    expect((calls[0][1] as Pick<QuerySpec, "where">).where).toEqual(filter);
  });

  test("drives every fluent method and read terminal without mutating the root", async () => {
    const { client, calls } = harness();
    const query = client
      .where({ body: { eq: "a" } })
      .where({ id: { gt: 0 } })
      .order({ body: "asc" })
      .select(["id"])
      .include({ notes: true })
      .limit(2)
      .offset(1);
    await query.toArray();
    await query.first();
    await query.find(1);
    await query.count();
    expect(calls.map(([name]) => name)).toEqual([
      "select",
      "select",
      "findOne",
      "count",
    ]);
    expect(calls[0][1]).toMatchObject({
      where: {
        and: [{ body: { eq: "a" } }, { id: { gt: 0 } }],
      },
      order: { body: "asc" },
      select: ["id"],
      include: { notes: true },
      limit: 2,
      offset: 1,
    });
    expect(calls[2][1]).toMatchObject({
      where: {
        and: [{ body: { eq: "a" } }, { id: { gt: 0 } }],
      },
      select: ["id"],
      include: { notes: true },
    });
  });

  test.each([
    ["limit", -1],
    ["limit", 1.5],
    ["limit", MAX_LIMIT + 1],
    ["limit", Number.MAX_SAFE_INTEGER + 1],
    ["offset", -1],
    ["offset", 1.5],
    ["offset", Number.NaN],
    ["offset", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("maps invalid %s %s to a safe read error", (method, value) => {
    const { client } = harness();
    expect(() => client[method](value)).toThrowError(
      expect.objectContaining({
        category: "INVALID_REQUEST",
        phase: "read",
        statusCode: 400,
      }),
    );
  });

  test("accepts exact limit and offset boundaries", async () => {
    const { client, calls } = harness();
    await client.limit(0).offset(0).toArray();
    await client.limit(MAX_LIMIT).offset(Number.MAX_SAFE_INTEGER).toArray();
    expect(calls.map(([, value]) => value)).toEqual([
      expect.objectContaining({ limit: 0, offset: 0 }),
      expect.objectContaining({
        limit: MAX_LIMIT,
        offset: Number.MAX_SAFE_INTEGER,
      }),
    ]);
  });

  test.each([
    [400, "INVALID_REQUEST"],
    [403, "FORBIDDEN"],
    [409, "CONFLICT"],
    [500, "INTERNAL"],
  ] as const)("maps executor status %s", async (status, category) => {
    const failing = new EntityClient({
      table: schema.$tables.notes,
      getDataPath: () => {
        throw new Error("must not run");
      },
      assertActive: vi.fn(),
      execute: async () => ({ ok: false, status, message: "safe" }),
    });
    await expect(failing.toArray()).rejects.toMatchObject({
      category,
      phase: "read",
      statusCode: status,
    });
  });

  test("rechecks activity inside delayed execution before DataPath access", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = true;
    const getDataPath = vi.fn(() => {
      throw new Error("must not access DataPath");
    });
    const client = new EntityClient({
      table: schema.$tables.notes,
      getDataPath,
      assertActive: () => {
        if (!active) throw new Error("inactive raw detail");
      },
      execute: async (operation) => {
        await gate;
        return { ok: true, data: await operation() };
      },
    });
    const operation = client.toArray();
    active = false;
    release();
    const error = await operation.catch((caught) => caught);
    expect(error).toMatchObject({ category: "INTERNAL", phase: "read" });
    expect(error.message).not.toContain("inactive raw detail");
    expect(error.cause).toBeUndefined();
    expect(getDataPath).not.toHaveBeenCalled();
  });

  test("snapshots fluent plain-data state", async () => {
    const { client, calls } = harness();
    const filter = { body: { eq: "before" } };
    const order = { body: "asc" as const };
    const include = { notes: { where: { body: { eq: "child" } } } };
    const columns = ["body"];
    const query = client
      .where(filter)
      .order(order)
      .include(include)
      .select(columns);
    filter.body.eq = "after";
    (order as { body: "asc" | "desc" }).body = "desc";
    include.notes.where.body.eq = "after";
    columns[0] = "id";

    await query.toArray();
    expect(calls[0][1]).toMatchObject({
      where: { body: { eq: "before" } },
      order: { body: "asc" },
      include: { notes: { where: { body: { eq: "child" } } } },
      select: ["body"],
    });
  });

  test("fails safely for cyclic fluent state and empty updates", async () => {
    const { client } = harness();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => client.where(cyclic as WhereClause)).toThrowError();
    await expect(client.update(1, {})).rejects.toMatchObject({
      category: "INVALID_REQUEST",
    });
  });

  test("validates trusted writes and drives every mutation terminal", async () => {
    const { client, calls } = harness();
    await client.create({ body: "a" });
    await client.update(1, { body: "b" });
    await client.upsert({ body: "c" }, { onConflict: "id" });
    await client.delete(1);
    expect(calls.map(([name]) => name)).toEqual([
      "insert",
      "update",
      "upsert",
      "delete",
    ]);
    await expect(client.create({ unknown: true } as Row)).rejects.toMatchObject(
      {
        category: "INVALID_REQUEST",
      },
    );
  });

  test("snapshots the upsert conflict target before deferred execution", async () => {
    const { client, calls } = harness();
    const options = { onConflict: "id" };
    const operation = client.upsert({ body: "a" }, options);
    options.onConflict = "body";
    await operation;
    expect(calls).toContainEqual(["upsert", "id"]);
  });
});
