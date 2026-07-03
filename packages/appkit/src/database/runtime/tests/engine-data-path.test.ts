import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../../contract";
import {
  boolean,
  defineSchema,
  fk,
  id,
  integer,
  text,
} from "../../schema-builder";
import { DataPathError, type IdValue, type Row } from "../data-path";
import { type AnyDb, createEngineDataPath, createEngineDb } from "../index";

const schema = defineSchema((t) => {
  const users = t.table("users", {
    id: id(),
    name: text(),
    age: integer(),
    active: boolean(),
    secret: text().private(),
  });
  const posts = t.table("posts", {
    id: id(),
    title: text(),
    secret: text().private(),
    authorId: fk(() => users.id).notNull(),
  });
  return { users, posts };
});

const users = schema.$tables.users;
const posts = schema.$tables.posts;

const dialect = new PgDialect();
function renderSql(frag: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(frag as SQL);
  return { sql, params: params as unknown[] };
}

/**
 * A hand-rolled stand-in for the Drizzle db. It records every call and returns
 * canned results so we can assert the engine DataPath delegates correctly (real
 * SQL round-trips are integration-tier). The chainable shape mirrors the exact
 * builder surface `engine/data-path.ts` reaches for.
 */
interface FakeResults {
  findMany?: Row[];
  findFirst?: Row;
  count?: number;
  insert?: Row[];
  upsert?: Row[];
  update?: Row[];
  delete?: { id: IdValue }[];
  execute?: unknown;
}

interface FakeCalls {
  findMany: { table: string; config: Record<string, unknown> }[];
  findFirst: { table: string; config: Record<string, unknown> }[];
  count: { table: unknown; filter: unknown }[];
  insert: { table: unknown; values: Row }[];
  upsert: {
    table: unknown;
    values: Row;
    config: { target: unknown; set: Row };
  }[];
  update: { table: unknown; values: Row; where: unknown }[];
  delete: { table: unknown; where: unknown; returning: unknown }[];
  execute: { fragment: unknown }[];
  transactions: number;
}

function makeFakeDb(
  results: FakeResults = {},
  options: { tables?: string[] } = {},
): { db: AnyDb; calls: FakeCalls } {
  const calls: FakeCalls = {
    findMany: [],
    findFirst: [],
    count: [],
    insert: [],
    upsert: [],
    update: [],
    delete: [],
    execute: [],
    transactions: 0,
  };

  const tableNames = options.tables ?? Object.keys(schema.$tables);

  const query: Record<string, unknown> = {};
  for (const name of tableNames) {
    query[name] = {
      async findMany(config: Record<string, unknown>) {
        calls.findMany.push({ table: name, config });
        return results.findMany ?? [];
      },
      async findFirst(config: Record<string, unknown>) {
        calls.findFirst.push({ table: name, config });
        return results.findFirst;
      },
    };
  }

  const db = {
    query,
    async $count(table: unknown, filter: unknown) {
      calls.count.push({ table, filter });
      return results.count ?? 0;
    },
    insert(table: unknown) {
      return {
        values(values: Row) {
          return {
            async returning() {
              calls.insert.push({ table, values });
              return results.insert ?? [];
            },
            onConflictDoUpdate(config: { target: unknown; set: Row }) {
              return {
                async returning() {
                  calls.upsert.push({ table, values, config });
                  return results.upsert ?? [];
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Row) {
          return {
            where(where: unknown) {
              return {
                async returning() {
                  calls.update.push({ table, values, where });
                  return results.update ?? [];
                },
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where(where: unknown) {
          return {
            async returning(returning: unknown) {
              calls.delete.push({ table, where, returning });
              return results.delete ?? [];
            },
          };
        },
      };
    },
    async execute(fragment: unknown) {
      calls.execute.push({ fragment });
      return results.execute ?? { rows: [] };
    },
    async transaction(fn: (tx: unknown) => unknown) {
      calls.transactions += 1;
      return fn(db);
    },
  };

  return { db: db as unknown as AnyDb, calls };
}

describe("createEngineDataPath — select", () => {
  it("delegates to findMany with translated where/order/limit/offset", async () => {
    const { db, calls } = makeFakeDb({ findMany: [{ id: 1 }] });
    const dp = createEngineDataPath(db, schema);

    const rows = await dp.select(users, {
      where: { name: "bob" },
      order: { name: "asc" },
      limit: 5,
      offset: 2,
    });

    expect(rows).toEqual([{ id: 1 }]);
    expect(calls.findMany).toHaveLength(1);
    const { table, config } = calls.findMany[0];
    expect(table).toBe("users");
    expect(config.limit).toBe(5);
    expect(config.offset).toBe(2);
    expect(renderSql(config.where).sql).toBe(`"users"."name" = $1`);
    expect(config.orderBy).toHaveLength(1);
    expect(config.with).toBeUndefined();
  });

  it("uses the default projection (drops private columns) without a select", async () => {
    const { db, calls } = makeFakeDb();
    const dp = createEngineDataPath(db, schema);

    await dp.select(users, {});

    expect(calls.findMany[0].config.columns).toEqual({
      id: true,
      name: true,
      age: true,
      active: true,
    });
    expect(calls.findMany[0].config.limit).toBe(DEFAULT_LIMIT);
  });

  it("caps explicit limits at MAX_LIMIT", async () => {
    const { db, calls } = makeFakeDb();
    const dp = createEngineDataPath(db, schema);

    await dp.select(users, { limit: MAX_LIMIT + 1 });

    expect(calls.findMany[0].config.limit).toBe(MAX_LIMIT);
  });

  it("rejects invalid limits", async () => {
    const { db } = makeFakeDb();
    const dp = createEngineDataPath(db, schema);

    await expect(dp.select(users, { limit: -1 })).rejects.toThrow(
      /non-negative integer/,
    );
  });

  it("lets an explicit select fetch a private column", async () => {
    const { db, calls } = makeFakeDb();
    const dp = createEngineDataPath(db, schema);

    await dp.select(users, { select: ["id", "secret"] });

    expect(calls.findMany[0].config.columns).toEqual({
      id: true,
      secret: true,
    });
  });

  it("forwards include as a `with` config", async () => {
    const { db, calls } = makeFakeDb();
    const dp = createEngineDataPath(db, schema);

    await dp.select(users, { include: { posts: true } });

    expect(calls.findMany[0].config.with).toEqual({
      posts: {
        columns: {
          id: true,
          title: true,
          authorId: true,
        },
      },
    });
  });

  it("looks up relational query builders by schema key", async () => {
    const aliasedSchema = defineSchema((t) => ({
      users: t.table("app_users", {
        id: id(),
        name: text(),
      }),
    }));
    const { db, calls } = makeFakeDb({}, { tables: ["users"] });
    const dp = createEngineDataPath(db, aliasedSchema);

    await dp.select(aliasedSchema.$tables.users, {});

    expect(calls.findMany[0].table).toBe("users");
  });
});

describe("createEngineDataPath — findOne", () => {
  it("looks up by primary key and returns the row", async () => {
    const { db, calls } = makeFakeDb({ findFirst: { id: 7, name: "x" } });
    const dp = createEngineDataPath(db, schema);

    const row = await dp.findOne(users, 7);

    expect(row).toEqual({ id: 7, name: "x" });
    const { sql, params } = renderSql(calls.findFirst[0].config.where);
    expect(sql).toBe(`"users"."id" = $1`);
    expect(params).toEqual([7]);
    expect(calls.findFirst[0].config.columns).toEqual({
      id: true,
      name: true,
      age: true,
      active: true,
    });
  });

  it("returns null when no row matches", async () => {
    const { db } = makeFakeDb({ findFirst: undefined });
    const dp = createEngineDataPath(db, schema);

    expect(await dp.findOne(users, 999)).toBeNull();
  });

  it("forwards include to a `with` config", async () => {
    const { db, calls } = makeFakeDb({ findFirst: { id: 1 } });
    const dp = createEngineDataPath(db, schema);

    await dp.findOne(users, 1, { include: { posts: true } });

    expect(calls.findFirst[0].config.with).toEqual({
      posts: {
        columns: {
          id: true,
          title: true,
          authorId: true,
        },
      },
    });
  });
});

describe("createEngineDataPath — count", () => {
  it("returns the engine count and forwards a translated filter", async () => {
    const { db, calls } = makeFakeDb({ count: 3 });
    const dp = createEngineDataPath(db, schema);

    expect(await dp.count(users, { active: true })).toBe(3);
    expect(calls.count).toHaveLength(1);
    expect(calls.count[0].table).toBe(users.$engine);
    expect(renderSql(calls.count[0].filter).sql).toBe(`"users"."active" = $1`);
  });

  it("passes an undefined filter when no where is given", async () => {
    const { db, calls } = makeFakeDb({ count: 0 });
    const dp = createEngineDataPath(db, schema);

    expect(await dp.count(users)).toBe(0);
    expect(calls.count[0].filter).toBeUndefined();
  });
});

describe("createEngineDataPath — insert / update / upsert / delete", () => {
  it("insert returns the first returned row and targets the engine table", async () => {
    const inserted = { id: 1, name: "new" };
    const { db, calls } = makeFakeDb({ insert: [inserted] });
    const dp = createEngineDataPath(db, schema);

    expect(await dp.insert(users, { name: "new" })).toEqual(inserted);
    expect(calls.insert[0].table).toBe(users.$engine);
    expect(calls.insert[0].values).toEqual({ name: "new" });
  });

  it("update returns the updated row, or null when nothing matched", async () => {
    const updated = { id: 1, name: "edit" };
    const ok = makeFakeDb({ update: [updated] });
    const dpOk = createEngineDataPath(ok.db, schema);

    expect(await dpOk.update(users, 1, { name: "edit" })).toEqual(updated);
    const { sql, params } = renderSql(ok.calls.update[0].where);
    expect(sql).toBe(`"users"."id" = $1`);
    expect(params).toEqual([1]);

    const miss = makeFakeDb({ update: [] });
    const dpMiss = createEngineDataPath(miss.db, schema);
    expect(await dpMiss.update(users, 2, { name: "x" })).toBeNull();
  });

  it("upsert maps onConflict columns to a target and returns the row", async () => {
    const row = { id: 1, name: "u" };
    const { db, calls } = makeFakeDb({ upsert: [row] });
    const dp = createEngineDataPath(db, schema);

    expect(await dp.upsert(users, { id: 1, name: "u" }, ["id"])).toEqual(row);
    const cfg = calls.upsert[0].config;
    expect(Array.isArray(cfg.target)).toBe(true);
    expect((cfg.target as unknown[]).length).toBe(1);
    expect(cfg.set).toEqual({ id: 1, name: "u" });
  });

  it("delete returns true when a row was removed and false otherwise", async () => {
    const hit = makeFakeDb({ delete: [{ id: 1 }] });
    const dpHit = createEngineDataPath(hit.db, schema);
    expect(await dpHit.delete(users, 1)).toBe(true);

    const missed = makeFakeDb({ delete: [] });
    const dpMissed = createEngineDataPath(missed.db, schema);
    expect(await dpMissed.delete(users, 2)).toBe(false);
  });
});

describe("createEngineDataPath — getColumn", () => {
  it("reads a single (even private) column by id", async () => {
    const { db, calls } = makeFakeDb({ findFirst: { secret: "s3cr3t" } });
    const dp = createEngineDataPath(db, schema);

    expect(await dp.getColumn(users, 1, "secret")).toBe("s3cr3t");
    expect(calls.findFirst[0].config.columns).toEqual({ secret: true });
  });

  it("returns null when the row is missing", async () => {
    const { db } = makeFakeDb({ findFirst: undefined });
    const dp = createEngineDataPath(db, schema);

    expect(await dp.getColumn(users, 1, "secret")).toBeNull();
  });
});

describe("createEngineDataPath — raw", () => {
  it("returns the rows array from the query result", async () => {
    const { db, calls } = makeFakeDb({ execute: { rows: [{ n: 1 }] } });
    const dp = createEngineDataPath(db, schema);

    const filterId = 5;
    const rows = await dp.raw`select * from users where id = ${filterId}`;

    expect(rows).toEqual([{ n: 1 }]);
    expect(calls.execute).toHaveLength(1);
  });

  it("falls back to the raw result when there is no `rows` field", async () => {
    const { db } = makeFakeDb({ execute: [{ n: 2 }] });
    const dp = createEngineDataPath(db, schema);

    expect(await dp.raw`select 1`).toEqual([{ n: 2 }]);
  });

  it("parameterizes interpolated values (no string injection)", async () => {
    const { db, calls } = makeFakeDb({ execute: { rows: [] } });
    const dp = createEngineDataPath(db, schema);

    const evil = "1; drop table users";
    await dp.raw`select * from users where id = ${evil}`;

    const { sql, params } = renderSql(calls.execute[0].fragment);
    expect(sql).toContain("$1");
    expect(sql).not.toContain("drop table");
    expect(params).toEqual([evil]);
  });
});

describe("createEngineDataPath — transaction", () => {
  it("runs the callback with a DataPath bound to the transaction", async () => {
    const { db, calls } = makeFakeDb({ insert: [{ id: 1, name: "tx" }] });
    const dp = createEngineDataPath(db, schema);

    const result = await dp.transaction((tx) =>
      tx.insert(users, { name: "tx" }),
    );

    expect(result).toEqual({ id: 1, name: "tx" });
    expect(calls.transactions).toBe(1);
    expect(calls.insert).toHaveLength(1);
  });

  it("propagates errors thrown inside the transaction (rollback path)", async () => {
    const { db } = makeFakeDb();
    const dp = createEngineDataPath(db, schema);

    await expect(
      dp.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("createEngineDataPath — unregistered table", () => {
  it("throws a 500 DataPathError when the table is not in the engine schema", async () => {
    const { db } = makeFakeDb({}, { tables: ["users"] });
    const dp = createEngineDataPath(db, schema);

    await expect(dp.select(posts, {})).rejects.toBeInstanceOf(DataPathError);
    await expect(dp.select(posts, {})).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

describe("createEngineDb", () => {
  let pool: Pool | undefined;

  afterAll(async () => {
    await pool?.end();
  });

  it("builds a db whose relational query API is reachable for every table", () => {
    pool = new Pool();
    const db = createEngineDb(pool, schema);

    const q = db.query as unknown as Record<
      string,
      { findMany?: unknown; findFirst?: unknown }
    >;
    expect(typeof q.users.findMany).toBe("function");
    expect(typeof q.users.findFirst).toBe("function");
    expect(typeof q.posts.findMany).toBe("function");
    expect(typeof q.posts.findFirst).toBe("function");
  });
});
