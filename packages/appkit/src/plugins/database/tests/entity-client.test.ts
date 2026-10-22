import { describe, expect, test, vi } from "vitest";

import { MAX_LIMIT, MAX_OFFSET } from "../../../database/contract";
import type {
  DataPath,
  QuerySpec,
  Row,
  WhereClause,
} from "../../../database/runtime";
import { defineSchema, id, text } from "../../../database/schema-builder";
import { EntityClient, type EntityClientContext } from "../entity-client";
import type { TransactionClient } from "../entity-types";
import { createTransactionScope, MAX_TRANSACTION_OPERATIONS } from "../scope";

const schema = defineSchema(({ table }) => {
  const notes = table("notes", { id: id(), body: text().notNull() });
  return { notes };
});

/**
 * Mirrors the transaction wiring `lifecycle.ts` builds, so joined writes
 * exercise the same scope publication and reuse the plugin does.
 */
function harness() {
  const calls: Array<[string, unknown, unknown?]> = [];
  const overrides: Partial<DataPath> = {};
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
    insert: async (table, values) => {
      calls.push(["insert", values]);
      return overrides.insert
        ? overrides.insert(table, values)
        : { id: 1, ...values };
    },
    update: async (table, rowId, values, where) => {
      calls.push(["update", values, where]);
      return overrides.update
        ? overrides.update(table, rowId, values)
        : { id: 1, ...values };
    },
    upsert: async (_table, values, target) => {
      calls.push(["upsert", target]);
      return { id: 1, ...values };
    },
    delete: async (table, rowId, where) => {
      calls.push(["delete", rowId, where]);
      return overrides.delete ? overrides.delete(table, rowId) : true;
    },
    raw: async () => [],
    transaction: async (callback) => {
      calls.push(["begin", undefined]);
      return overrides.transaction
        ? overrides.transaction(callback)
        : callback(dataPath);
    },
  };
  const scope = createTransactionScope();

  const contextFor = (transactionBound: boolean): EntityClientContext => ({
    table: schema.$tables.notes,
    getDataPath: () => dataPath,
    assertActive: vi.fn(),
    execute: async (operation) => ({ ok: true, data: await operation() }),
    scope,
    transactionBound,
    activeEntity: () => {
      const active = scope.activeTransaction();
      return active ? notesOf(active) : undefined;
    },
  });

  const context = contextFor(false);
  return {
    client: new EntityClient(context),
    boundClient: () => new EntityClient(contextFor(true)),
    context,
    scope,
    calls,
    overrides,
  };
}

const names = (calls: Array<[string, unknown, unknown?]>) =>
  calls.map(([name]) => name);

/** The registry is empty until typegen runs, so entities are reached by name. */
const notesOf = (database: TransactionClient) =>
  (database as unknown as { notes: EntityClient }).notes;

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
    ["offset", MAX_OFFSET + 1],
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
    await client.limit(MAX_LIMIT).offset(MAX_OFFSET).toArray();
    expect(calls.map(([, value]) => value)).toEqual([
      expect.objectContaining({ limit: 0, offset: 0 }),
      expect.objectContaining({
        limit: MAX_LIMIT,
        offset: MAX_OFFSET,
      }),
    ]);
  });

  test.each([
    [400, "INVALID_REQUEST", false],
    [403, "FORBIDDEN", false],
    [409, "CONFLICT", false],
    [500, "INTERNAL", false],
    [503, "TRANSIENT", true],
  ] as const)(
    "maps executor status %s",
    async (status, category, isRetryable) => {
      const failing = new EntityClient({
        ...harness().context,
        getDataPath: () => {
          throw new Error("must not run");
        },
        execute: async () => ({ ok: false, status, message: "safe" }),
      });
      await expect(failing.toArray()).rejects.toMatchObject({
        category,
        isRetryable,
        phase: "read",
        statusCode: status,
      });
    },
  );

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
      ...harness().context,
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
      phase: "write",
      details: [
        {
          path: ["body"],
          message:
            "Update must contain at least one field; skip the call when there are no changes",
        },
      ],
    });
  });

  test("validates trusted writes and drives every mutation terminal", async () => {
    const { client, calls } = harness();
    await client.create({ body: "a" });
    await client.update(1, { body: "b" });
    await client.upsert({ body: "c" }, { onConflict: "id" });
    await client.delete(1);
    expect(names(calls)).toEqual(["insert", "update", "upsert", "delete"]);
    await expect(client.create({ unknown: true } as Row)).rejects.toMatchObject(
      {
        category: "INVALID_REQUEST",
      },
    );
  });

  test("narrows keyed mutations by the accumulated predicate", async () => {
    const { client, calls } = harness();
    const scoped = client.where({ body: "owned" });
    await scoped.update(1, { body: "b" });
    await scoped.delete(1);
    expect(calls).toEqual([
      ["update", { body: "b" }, { body: "owned" }],
      ["delete", 1, { body: "owned" }],
    ]);
  });

  test("refuses inserts that would silently drop a predicate", async () => {
    const { client, calls } = harness();
    const scoped = client.where({ body: "owned" });
    const rejected = [
      scoped.create({ body: "a" }),
      scoped.upsert({ body: "a" }, { onConflict: "id" }),
    ];
    await expect(rejected[0]).rejects.toMatchObject({
      category: "INVALID_REQUEST",
      phase: "runtime",
    });
    await expect(rejected[1]).rejects.toMatchObject({
      category: "INVALID_REQUEST",
    });
    const settled = await Promise.allSettled(rejected);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    expect(calls).toEqual([]);
  });

  test("snapshots the upsert conflict target before deferred execution", async () => {
    const { client, calls } = harness();
    const options = { onConflict: "id" };
    const operation = client.upsert({ body: "a" }, options);
    options.onConflict = "body";
    await operation;
    expect(calls).toContainEqual(["upsert", "id"]);
  });

  test("keeps a root mutation on the direct path", async () => {
    const { client, calls } = harness();
    await client.create({ body: "a" });
    await client.delete(1);
    expect(names(calls)).toEqual(["insert", "delete"]);
  });

  test("joins an open transaction without opening another", async () => {
    const joined = harness();
    const bound = joined.boundClient();
    const transaction = { notes: bound } as unknown as TransactionClient;

    await joined.scope.runWithTransaction(transaction, () =>
      joined.client.create({ body: "joined" }),
    );

    expect(names(joined.calls)).toEqual(["insert"]);
  });

  test("clones a joined write's predicate onto the bound client", async () => {
    const joined = harness();
    const transaction = {
      notes: joined.boundClient(),
    } as unknown as TransactionClient;

    await joined.scope.runWithTransaction(transaction, () =>
      joined.client.where({ body: "owned" }).update(1, { body: "b" }),
    );

    expect(joined.calls).toEqual([
      ["update", { body: "b" }, { body: "owned" }],
    ]);
    await joined.client.where({ body: "other" }).update(1, { body: "c" });
    expect(joined.calls.at(-1)).toEqual([
      "update",
      { body: "c" },
      { body: "other" },
    ]);
  });

  test("returns no-match from a joined update without treating it as a fault", async () => {
    const joined = harness();
    joined.overrides.update = async () => null;
    const transaction = {
      notes: joined.boundClient(),
    } as unknown as TransactionClient;

    await expect(
      joined.scope.runWithTransaction(transaction, () =>
        joined.client.update(999, { body: "missing" }),
      ),
    ).resolves.toBeNull();
  });

  test("charges one budget entry for each bound write", async () => {
    const joined = harness();
    const bound = joined.boundClient();
    const transaction = { notes: bound } as unknown as TransactionClient;

    const overflow = joined.scope.runWithTransaction(transaction, async () => {
      for (let index = 0; index <= MAX_TRANSACTION_OPERATIONS; index++) {
        await bound.create({ body: `${index}` });
      }
    });
    const caught = await overflow.catch((error) => error);
    expect(caught).toMatchObject({ category: "INTERNAL", phase: "write" });
    expect(names(joined.calls).filter((name) => name === "insert").length).toBe(
      MAX_TRANSACTION_OPERATIONS,
    );
  });
});
