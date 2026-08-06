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

import { createDatabaseState } from "../lifecycle";

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

type TestEntity = {
  create(values: Row): Promise<Row>;
  toArray(): Promise<Row[]>;
};
type TestExports = {
  notes: TestEntity;
  sql: DataPath["raw"];
  transaction<T>(
    callback: (tx: { notes: TestEntity; sql: DataPath["raw"] }) => Promise<T>,
  ): Promise<T>;
};

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
    expect(mocks.createLakebasePool).toHaveBeenCalledWith();
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
    const exports = state.exports as unknown as TestExports;
    let captured!: Parameters<Parameters<TestExports["transaction"]>[0]>[0];
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
});
