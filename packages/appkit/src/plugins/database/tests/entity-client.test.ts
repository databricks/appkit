import { describe, expect, test, vi } from "vitest";

import { MAX_LIMIT, MAX_OFFSET } from "../../../database/contract";
import { DatabasePluginError } from "../../../database/errors";
import type {
  DataPath,
  QuerySpec,
  Row,
  WhereClause,
} from "../../../database/runtime";
import { defineSchema, id, text } from "../../../database/schema-builder";
import { DatabaseValidationError } from "../../../errors";
import { EntityClient, type EntityClientContext } from "../entity-client";
import type { TransactionClient } from "../entity-types";
import { createMutationScope, MAX_TRANSACTION_OPERATIONS } from "../scope";
import type { EntityHooks } from "../types";

const schema = defineSchema(({ table }) => {
  const notes = table("notes", { id: id(), body: text().notNull() });
  return { notes };
});

/**
 * Mirrors the transaction wiring `lifecycle.ts` builds, so hooked mutations
 * exercise the same redirect, scope publication, and reuse the plugin does.
 */
function harness(hooks?: EntityHooks) {
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
  const scope = createMutationScope();

  const contextFor = (transactionBound: boolean): EntityClientContext => ({
    table: schema.$tables.notes,
    getDataPath: () => dataPath,
    assertActive: vi.fn(),
    execute: async (operation) => ({ ok: true, data: await operation() }),
    scope,
    hooks,
    transactionBound,
    runInTransaction: (run) => {
      const active = scope.activeTransaction();
      if (active) return run(notesOf(active));
      const bound = new EntityClient(contextFor(true));
      const tx = { notes: bound } as unknown as TransactionClient;
      return dataPath.transaction(() =>
        scope.runWithTransaction(tx, () => run(bound)),
      );
    },
  });

  const context = contextFor(false);
  return {
    client: new EntityClient(context),
    boundClient: () => new EntityClient(contextFor(true)),
    context,
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
    await expect(scoped.create({ body: "a" })).rejects.toMatchObject({
      category: "INVALID_REQUEST",
    });
    await expect(
      scoped.upsert({ body: "a" }, { onConflict: "id" }),
    ).rejects.toMatchObject({ category: "INVALID_REQUEST" });
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
});

describe("EntityClient mutation hooks", () => {
  test("keeps an unhooked mutation on the direct path", async () => {
    const { client, calls } = harness({ afterUpdate: vi.fn() });
    await client.create({ body: "a" });
    await client.delete(1);
    expect(names(calls)).toEqual(["insert", "delete"]);
  });

  test("wraps a hooked mutation in one transaction and runs hooks in order", async () => {
    const order: string[] = [];
    const { client, calls } = harness({
      beforeCreate: (values) => {
        order.push(`before:${values.body}`);
      },
      afterCreate: (row) => {
        order.push(`after:${row.id}`);
      },
    });
    await expect(client.create({ body: "a" })).resolves.toEqual({
      id: 1,
      body: "a",
    });
    expect(names(calls)).toEqual(["begin", "insert"]);
    expect(order).toEqual(["before:a", "after:1"]);
  });

  test("persists and revalidates a replacement payload", async () => {
    const { client, calls } = harness({
      beforeCreate: (values) => ({ ...values, body: `${values.body}!` }),
    });
    await client.create({ body: "a" });
    expect(calls).toContainEqual(["insert", { body: "a!" }]);

    // The caller's payload was valid, so the hook's replacement is our fault.
    const rejected = harness({ beforeCreate: () => ({ unknown: true }) });
    await expect(rejected.client.create({ body: "a" })).rejects.toMatchObject({
      category: "INTERNAL",
      phase: "write",
    });
    expect(names(rejected.calls)).toEqual(["begin"]);
  });

  test("gives upsert its own branch-opaque lifecycle", async () => {
    const seen: string[] = [];
    const { client } = harness({
      beforeCreate: () => {
        seen.push("beforeCreate");
      },
      afterCreate: () => {
        seen.push("afterCreate");
      },
      beforeUpsert: () => {
        seen.push("beforeUpsert");
      },
      afterUpsert: (row) => {
        // The hook sees the resulting row, never which branch produced it.
        seen.push(`afterUpsert:${Object.keys(row).join()}`);
      },
    });
    await client.upsert({ body: "a" }, { onConflict: "id" });
    expect(seen).toEqual(["beforeUpsert", "afterUpsert:id,body"]);
  });

  test("runs after hooks only once the mutation matched a row", async () => {
    const afterUpdate = vi.fn();
    const afterDelete = vi.fn();
    const missing = harness({ afterUpdate, afterDelete });
    missing.overrides.update = async () => null;
    missing.overrides.delete = async () => false;
    await expect(missing.client.update(1, { body: "b" })).resolves.toBeNull();
    await expect(missing.client.delete(1)).resolves.toBe(false);
    expect(afterUpdate).not.toHaveBeenCalled();
    expect(afterDelete).not.toHaveBeenCalled();

    const matched = harness({ afterUpdate, afterDelete });
    await matched.client.update(1, { body: "b" });
    await matched.client.delete(1);
    expect(afterUpdate).toHaveBeenCalledTimes(1);
    expect(afterDelete).toHaveBeenCalledWith(1, expect.anything());
  });

  test("rolls before-hook writes back when update or delete matches no row", async () => {
    const update = harness({
      beforeUpdate: async (_id, _values, context) => {
        await notesOf(context.app.database).create({ body: "audit" });
      },
    });
    update.overrides.update = async () => null;
    let updateRolledBack = false;
    update.overrides.transaction = async (callback) => {
      try {
        return await callback(update.context.getDataPath());
      } catch (error) {
        updateRolledBack = true;
        throw error;
      }
    };
    await expect(
      update.client.update(999, { body: "missing" }),
    ).resolves.toBeNull();
    expect(updateRolledBack).toBe(true);
    expect(names(update.calls)).toEqual(["begin", "insert", "update"]);

    const remove = harness({
      beforeDelete: async (_id, context) => {
        await notesOf(context.app.database).create({ body: "audit" });
      },
    });
    remove.overrides.delete = async () => false;
    let deleteRolledBack = false;
    remove.overrides.transaction = async (callback) => {
      try {
        return await callback(remove.context.getDataPath());
      } catch (error) {
        deleteRolledBack = true;
        throw error;
      }
    };
    await expect(remove.client.delete(999)).resolves.toBe(false);
    expect(deleteRolledBack).toBe(true);
    expect(names(remove.calls)).toEqual(["begin", "insert", "delete"]);
  });

  test("keeps no-match as a rollback signal inside an explicit transaction", async () => {
    const joined = harness({ beforeUpdate: vi.fn() });
    joined.overrides.update = async () => null;
    const transaction = {
      notes: joined.boundClient(),
    } as unknown as TransactionClient;

    await expect(
      joined.context.scope.runWithTransaction(transaction, () =>
        joined.client.update(999, { body: "missing" }),
      ),
    ).rejects.toMatchObject({ category: "NOT_FOUND", phase: "write" });
  });

  test("does not mistake a hook-issued no-match for the primary result", async () => {
    const nested = harness({
      afterUpdate: async (_row, context) => {
        await notesOf(context.app.database).delete(999);
      },
      beforeDelete: vi.fn(),
    });
    nested.overrides.delete = async () => false;

    await expect(
      nested.client.update(1, { body: "changed" }),
    ).rejects.toMatchObject({ category: "NOT_FOUND", phase: "write" });
  });

  test("skips the after hook when the mutation itself is rejected", async () => {
    const afterCreate = vi.fn();
    const { client, overrides } = harness({
      beforeCreate: vi.fn(),
      afterCreate,
    });
    overrides.insert = async () => {
      throw new DatabasePluginError("CONFLICT", "write");
    };
    await expect(client.create({ body: "a" })).rejects.toMatchObject({
      category: "CONFLICT",
    });
    expect(afterCreate).not.toHaveBeenCalled();
  });

  test("exposes the entity and the transaction surface, and nothing else", async () => {
    let seen: unknown;
    const { client, calls } = harness({
      beforeCreate: (_values, context) => {
        seen = context;
      },
      afterCreate: async (_row, context) => {
        await notesOf(context.app.database).update(1, { body: "related" });
      },
    });
    await client.create({ body: "a" });
    expect(seen).toMatchObject({ entity: "notes" });
    expect(Object.keys(seen as { app: object }).sort()).toEqual([
      "app",
      "entity",
    ]);
    expect(Object.keys((seen as { app: Record<string, unknown> }).app)).toEqual(
      ["database"],
    );
    // The related write joins the open transaction instead of starting one.
    expect(names(calls)).toEqual(["begin", "insert", "update"]);
  });

  test("keeps a deliberate validation failure and collapses every other fault", async () => {
    const issues = [{ path: ["body"], message: "too short" }];
    const rejected = harness({
      beforeCreate: () => {
        throw new DatabaseValidationError("invalid note", issues);
      },
    });
    const validation = await rejected.client
      .create({ body: "a" })
      .catch((error) => error);
    expect(validation).toBeInstanceOf(DatabaseValidationError);
    expect(validation.issues).toEqual(issues);

    const broken = harness({
      afterCreate: () => {
        throw new Error("insert into notes values ('secret')");
      },
    });
    const failure = await broken.client
      .create({ body: "a" })
      .catch((error) => error);
    expect(failure).toMatchObject({ category: "INTERNAL", phase: "write" });
    expect(failure.message).not.toContain("secret");
    expect(failure.cause).toBeUndefined();
  });

  test("collapses a failure raised by the transaction itself", async () => {
    const { client, overrides } = harness({ afterCreate: vi.fn() });
    overrides.transaction = async () => {
      throw new Error("COMMIT failed on notes_pkey");
    };
    const failure = await client.create({ body: "a" }).catch((error) => error);
    expect(failure).toBeInstanceOf(DatabasePluginError);
    expect(failure.message).not.toContain("notes_pkey");
  });

  test("bounds sibling writes issued by one hook", async () => {
    const { client, calls } = harness({
      beforeUpdate: async (_id, _values, context) => {
        for (let index = 0; index < MAX_TRANSACTION_OPERATIONS; index++) {
          await notesOf(context.app.database).create({ body: `${index}` });
        }
      },
    });

    await expect(client.update(1, { body: "changed" })).rejects.toMatchObject({
      category: "INTERNAL",
      phase: "write",
    });
    expect(
      names(calls).filter((name) => name === "insert").length,
    ).toBeLessThan(MAX_TRANSACTION_OPERATIONS);
    expect(names(calls)).not.toContain("update");
  });

  test("refuses a hook that re-enters the same mutation", async () => {
    const { client } = harness({
      beforeCreate: async (values, context) => {
        await notesOf(context.app.database).create(values);
      },
    });
    await expect(client.create({ body: "a" })).rejects.toMatchObject({
      category: "INTERNAL",
      phase: "write",
    });
  });
});
