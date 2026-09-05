import { describe, expect, test, vi } from "vitest";

import { DatabasePluginError } from "../../../database/errors";
import type { DataPath, Row } from "../../../database/runtime";
import { defineSchema, id, text } from "../../../database/schema-builder";

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

import {
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  TRANSACTION_TIMEOUT_MS,
} from "../defaults";
import type { EntityClient } from "../entity-client";
import { createDatabaseState } from "../lifecycle";
import { MAX_TRANSACTION_OPERATIONS } from "../scope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const schema = defineSchema(({ table }) => {
  const notes = table("notes", { id: id(), body: text().notNull() });
  const tags = table("tags", { id: id(), label: text() });
  return { notes, tags };
});

function fakePath(overrides: Partial<DataPath> = {}): DataPath {
  const path: DataPath = {
    select: vi.fn(async () => []),
    findOne: vi.fn(async () => null),
    count: vi.fn(async () => 0),
    insert: vi.fn(async (_table, values) => ({ id: 1, ...values })),
    update: vi.fn(async (_table, id, values) => ({ id, ...values })),
    upsert: vi.fn(async (_table, values) => ({ id: 1, ...values })),
    delete: vi.fn(async () => true),
    raw: vi.fn(async () => []),
    transaction: vi.fn(async (callback) => callback(path)),
    ...overrides,
  };
  return path;
}

type TestEntity = Pick<
  EntityClient,
  "create" | "toArray" | "where" | "update" | "delete"
>;
type TestTransaction = {
  notes: TestEntity;
  tags: TestEntity;
  sql: DataPath["raw"];
};
type TestExports = TestTransaction & {
  transaction<T>(callback: (tx: TestTransaction) => Promise<T>): Promise<T>;
};

// The registry is empty until typegen runs, so entities are reached by name.
const surface = (state: { exports: unknown }) =>
  state.exports as unknown as TestExports;
const txSurface = (tx: unknown) => tx as TestTransaction;

function arrange(path = fakePath()) {
  const pool = { end: vi.fn(async () => undefined) };
  const db = { marker: Symbol("db") };
  mocks.createLakebasePool.mockReturnValue(pool);
  mocks.createDrizzleDb.mockReturnValue(db);
  mocks.createDrizzleDataPath.mockReturnValue(path);
  const execute = vi.fn(async (operation) => ({
    ok: true as const,
    data: await operation(),
  }));
  return { pool, db, path, execute };
}

describe("createDatabaseState", () => {
  test("accepts authentic populated and empty schemas but rejects a forgery before allocation", async () => {
    arrange();
    await expect(
      createDatabaseState(schema, arrange().execute),
    ).resolves.toBeDefined();
    await expect(
      createDatabaseState(
        defineSchema(() => ({})),
        arrange().execute,
      ),
    ).resolves.toBeDefined();
    mocks.createLakebasePool.mockClear();
    await expect(
      createDatabaseState(
        { $tables: Object.create(null) } as typeof schema,
        arrange().execute,
      ),
    ).rejects.toMatchObject({ category: "SETUP_FAILED", phase: "setup" });
    expect(mocks.createLakebasePool).not.toHaveBeenCalled();
  });

  test("builds one default runtime, all entities, and waits for readiness", async () => {
    const ready = deferred<Row[]>();
    const path = fakePath({
      raw: vi.fn(async () => ready.promise) as unknown as DataPath["raw"],
    });
    const { pool, db, execute } = arrange(path);
    const pending = createDatabaseState(schema, execute);
    await vi.waitFor(() => expect(path.raw).toHaveBeenCalledTimes(1));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    ready.resolve([]);
    const state = await pending;
    expect(mocks.createLakebasePool).toHaveBeenCalledTimes(1);
    expect(mocks.createLakebasePool).toHaveBeenCalledWith({
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    });
    expect(mocks.createDrizzleDb).toHaveBeenCalledWith(pool, schema);
    expect(mocks.createDrizzleDataPath).toHaveBeenCalledWith(db, schema, {
      columnAccess: "trusted",
    });
    expect(Object.keys(state.exports).sort()).toEqual([
      "notes",
      "sql",
      "tags",
      "transaction",
    ]);
    expect(state.exports).not.toHaveProperty("getPool");
    expect((state.exports as unknown as TestExports).notes).not.toHaveProperty(
      "unbounded",
    );
  });

  test.each(["drizzle", "dataPath", "readiness"] as const)(
    "closes and sanitizes %s construction failures",
    async (stage) => {
      const { pool, execute } = arrange();
      const raw = new Error("secret constraint detail");
      if (stage === "drizzle")
        mocks.createDrizzleDb.mockImplementationOnce(() => {
          throw raw;
        });
      if (stage === "dataPath")
        mocks.createDrizzleDataPath.mockImplementationOnce(() => {
          throw raw;
        });
      if (stage === "readiness")
        mocks.createDrizzleDataPath.mockReturnValueOnce(
          fakePath({
            raw: vi.fn(async () => {
              throw new DatabasePluginError("INTERNAL", "runtime", raw.message);
            }),
          }),
        );
      const error = await createDatabaseState(schema, execute).catch(
        (value) => value,
      );
      expect(error).toMatchObject({ category: "SETUP_FAILED", phase: "setup" });
      expect(error.message).toBe("Database setup failed");
      expect(error.cause).toBeUndefined();
      expect(pool.end).toHaveBeenCalledTimes(1);
    },
  );

  test("sanitizes synchronous pool construction failures", async () => {
    const { execute } = arrange();
    mocks.createLakebasePool.mockImplementationOnce(() => {
      throw new Error("secret host and credential details");
    });

    const error = await createDatabaseState(schema, execute).catch(
      (caught) => caught,
    );

    expect(error).toMatchObject({ category: "SETUP_FAILED", phase: "setup" });
    expect(error.message).toBe("Database setup failed");
    expect(error.cause).toBeUndefined();
  });

  test("runs root SQL directly, maps failures safely, and rejects after deactivation", async () => {
    const path = fakePath();
    const { execute } = arrange(path);
    const state = await createDatabaseState(schema, execute);
    await state.exports.sql`select ${1}`;
    expect(path.raw).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    for (const [category, expected] of [
      ["INVALID_REQUEST", "INVALID_REQUEST"],
      ["CONFLICT", "CONFLICT"],
      ["FORBIDDEN", "FORBIDDEN"],
      ["TRANSIENT", "TRANSIENT"],
      ["INTERNAL", "INTERNAL"],
    ] as const) {
      vi.mocked(path.raw).mockRejectedValueOnce(
        new DatabasePluginError(category, "runtime", "raw secret"),
      );
      await expect(state.exports.sql`bad`).rejects.toMatchObject({
        category: expected,
      });
    }
    state.deactivate();
    await expect(state.exports.sql`select 1`).rejects.toMatchObject({
      category: "INTERNAL",
      phase: "read",
    });
  });

  test("commits, rolls back, binds tx capabilities, and expires them", async () => {
    const txPath = fakePath();
    const rootPath = fakePath({
      transaction: vi.fn(async (callback) => callback(txPath)),
    });
    const { execute } = arrange(rootPath);
    const state = await createDatabaseState(schema, execute);
    const exports = surface(state);
    let captured!: TestTransaction;
    await expect(
      exports.transaction(async (tx) => {
        captured = tx;
        await tx.notes.create({ body: "created" });
        await tx.sql`select ${1}`;
        expect(tx).not.toHaveProperty("transaction");
        return "committed";
      }),
    ).resolves.toBe("committed");
    expect(rootPath.transaction).toHaveBeenCalledTimes(1);
    expect(txPath.insert).toHaveBeenCalledTimes(1);
    expect(txPath.raw).toHaveBeenCalledTimes(1);
    await expect(captured.notes.toArray()).rejects.toMatchObject({
      category: "INTERNAL",
    });
    await expect(captured.sql`select 1`).rejects.toMatchObject({
      category: "INTERNAL",
    });

    await expect(
      exports.transaction(async () => {
        throw new Error("rollback");
      }),
    ).rejects.toMatchObject({ category: "INTERNAL" });
  });

  test("keeps independently created states isolated", async () => {
    const first = arrange();
    const stateOne = await createDatabaseState(schema, first.execute);
    const second = arrange();
    const stateTwo = await createDatabaseState(schema, second.execute);
    expect(stateOne.pool).not.toBe(stateTwo.pool);
    expect(stateOne.exports).not.toBe(stateTwo.exports);
    stateOne.deactivate();
    await expect(stateOne.exports.sql`select 1`).rejects.toBeDefined();
    await expect(stateTwo.exports.sql`select 1`).resolves.toEqual([]);
  });

  test("runs a hooked mutation in one transaction that hook writes reuse", async () => {
    const txPath = fakePath();
    const rootPath = fakePath({
      transaction: vi.fn(async (callback) => callback(txPath)),
    });
    const { execute } = arrange(rootPath);
    const state = await createDatabaseState(schema, execute, {
      notes: {
        afterCreate: async (_row, context) => {
          await txSurface(context.app.database).tags.create({ label: "audit" });
        },
      },
    });

    await surface(state).notes.create({ body: "hooked" });

    expect(rootPath.transaction).toHaveBeenCalledTimes(1);
    expect(rootPath.insert).not.toHaveBeenCalled();
    expect(txPath.insert).toHaveBeenCalledTimes(2);
    // Reuse means the related write never opens a nested transaction.
    expect(txPath.transaction).not.toHaveBeenCalled();
  });

  test("bounds SQL fan-out issued by one hook", async () => {
    let rolledBack = false;
    const txPath = fakePath();
    const rootPath = fakePath({
      transaction: vi.fn(async (callback) => {
        try {
          return await callback(txPath);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      }),
    });
    const { execute } = arrange(rootPath);
    const state = await createDatabaseState(schema, execute, {
      notes: {
        beforeCreate: async (_values, context) => {
          for (let index = 0; index < MAX_TRANSACTION_OPERATIONS; index++) {
            await context.app.database.sql`select ${index}`;
          }
        },
      },
    });

    await expect(
      surface(state).notes.create({ body: "hooked" }),
    ).rejects.toMatchObject({ category: "INTERNAL", phase: "write" });
    expect(rolledBack).toBe(true);
    expect(txPath.raw).toHaveBeenCalledTimes(MAX_TRANSACTION_OPERATIONS - 1);
    expect(txPath.insert).not.toHaveBeenCalled();
  });

  test("rolls back and closes a transaction when its wall-clock deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const started = deferred<void>();
      const resume = deferred<void>();
      const finished = deferred<void>();
      let rolledBack = false;
      const txPath = fakePath();
      const rootPath = fakePath({
        transaction: vi.fn(async (callback) => {
          try {
            return await callback(txPath);
          } catch (error) {
            rolledBack = true;
            throw error;
          }
        }),
      });
      const { execute } = arrange(rootPath);
      const state = await createDatabaseState(schema, execute, {
        notes: {
          beforeCreate: async (_values, context) => {
            started.resolve(undefined);
            await resume.promise;
            try {
              await txSurface(context.app.database).tags.create({
                label: "late",
              });
            } finally {
              finished.resolve(undefined);
            }
          },
        },
      });

      const failure = surface(state)
        .notes.create({ body: "hooked" })
        .catch((error) => error);
      await started.promise;
      await vi.advanceTimersByTimeAsync(TRANSACTION_TIMEOUT_MS);

      await expect(failure).resolves.toMatchObject({
        category: "TRANSIENT",
        phase: "write",
      });
      expect(rolledBack).toBe(true);
      resume.resolve(undefined);
      await finished.promise;
      expect(txPath.insert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps an unhooked mutation off the transaction path", async () => {
    const rootPath = fakePath();
    const { execute } = arrange(rootPath);
    const state = await createDatabaseState(schema, execute, {
      notes: { serialize: (row) => row },
    });
    await surface(state).notes.create({ body: "direct" });
    expect(rootPath.transaction).not.toHaveBeenCalled();
    expect(rootPath.insert).toHaveBeenCalledTimes(1);
  });

  test("makes an unhooked root mutation join an open transaction", async () => {
    const txPath = fakePath();
    const rootPath = fakePath({
      transaction: vi.fn(async (callback) => callback(txPath)),
    });
    const { execute } = arrange(rootPath);
    const state = await createDatabaseState(schema, execute);
    const exports = surface(state);

    await exports.transaction(async () => {
      // Reaching past `tx` for the root surface must not commit on the pool.
      await exports.tags.create({ label: "joined" });
    });

    expect(rootPath.transaction).toHaveBeenCalledTimes(1);
    expect(rootPath.insert).not.toHaveBeenCalled();
    expect(txPath.insert).toHaveBeenCalledTimes(1);
    expect(txPath.transaction).not.toHaveBeenCalled();
  });

  test.each([
    ["hooked root", "automatic", true],
    ["root joining a transaction", "root", false],
    ["hooked root joining a transaction", "root", true],
    ["transaction client", "bound", false],
    ["hooked transaction client", "bound", true],
  ] as const)(
    "preserves keyed mutation predicates for a %s",
    async (_name, mode, hooked) => {
      const txPath = fakePath();
      const rootPath = fakePath({
        transaction: vi.fn(async (callback) => callback(txPath)),
      });
      const { execute } = arrange(rootPath);
      const beforeUpdate = vi.fn();
      const beforeDelete = vi.fn();
      const state = await createDatabaseState(
        schema,
        execute,
        hooked ? { notes: { beforeUpdate, beforeDelete } } : undefined,
      );
      const exports = surface(state);
      const predicate = {
        and: [{ body: { eq: "original" } }, { id: { gt: 0 } }],
      };
      const mutate = async (entity: TestEntity) => {
        const scoped = entity
          .where({ body: { eq: "original" } })
          .where({ id: { gt: 0 } });
        await scoped.update(1, { body: "updated" });
        await scoped.delete(1);
      };

      if (mode === "automatic") {
        await mutate(exports.notes);
      } else {
        await exports.transaction(async (tx) => {
          await mutate(mode === "root" ? exports.notes : tx.notes);
          // A scoped operation must not change the shared transaction client.
          await tx.notes.update(2, { body: "unfiltered" });
          expect(txPath.update).toHaveBeenLastCalledWith(
            schema.$tables.notes,
            2,
            { body: "unfiltered" },
            undefined,
          );
        });
      }

      expect(txPath.update).toHaveBeenNthCalledWith(
        1,
        schema.$tables.notes,
        1,
        { body: "updated" },
        predicate,
      );
      expect(txPath.delete).toHaveBeenCalledExactlyOnceWith(
        schema.$tables.notes,
        1,
        predicate,
      );
      expect(rootPath.update).not.toHaveBeenCalled();
      expect(rootPath.delete).not.toHaveBeenCalled();
      expect(rootPath.transaction).toHaveBeenCalledTimes(
        mode === "automatic" ? 2 : 1,
      );
      expect(txPath.transaction).not.toHaveBeenCalled();
      expect(beforeUpdate).toHaveBeenCalledTimes(
        hooked ? (mode === "automatic" ? 1 : 2) : 0,
      );
      expect(beforeDelete).toHaveBeenCalledTimes(hooked ? 1 : 0);
    },
  );

  test("rolls the hook's related write back with the primary mutation", async () => {
    let rolledBack = false;
    const txPath = fakePath({
      insert: vi.fn(async (table, values) => {
        if (table.$name === "tags") throw new Error("audit trail is full");
        return { id: 1, ...values };
      }),
    });
    const rootPath = fakePath({
      // A real driver rolls back and rethrows whatever the callback raised.
      transaction: vi.fn(async (callback) => {
        try {
          return await callback(txPath);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      }),
    });
    const { execute } = arrange(rootPath);
    const state = await createDatabaseState(schema, execute, {
      notes: {
        afterCreate: async (_row, context) => {
          await txSurface(context.app.database).tags.create({ label: "audit" });
        },
      },
    });

    const error = await surface(state)
      .notes.create({ body: "hooked" })
      .catch((caught) => caught);

    expect(rolledBack).toBe(true);
    expect(error).toMatchObject({ category: "INTERNAL", phase: "write" });
    expect(error.message).not.toContain("audit trail is full");
  });

  test("gives each instance a scope the other cannot join", async () => {
    const first = arrange(
      fakePath({
        transaction: vi.fn(async (callback) => callback(fakePath())),
      }),
    );
    const stateOne = await createDatabaseState(schema, first.execute);
    const second = arrange(
      fakePath({
        transaction: vi.fn(async (callback) => callback(fakePath())),
      }),
    );
    const stateTwo = await createDatabaseState(schema, second.execute, {
      notes: { afterCreate: vi.fn() },
    });

    await surface(stateOne).transaction(async () => {
      await surface(stateTwo).notes.create({ body: "independent" });
    });

    // The second instance opened its own transaction instead of joining.
    expect(second.path.transaction).toHaveBeenCalledTimes(1);
    expect(first.path.insert).not.toHaveBeenCalled();
  });
});
