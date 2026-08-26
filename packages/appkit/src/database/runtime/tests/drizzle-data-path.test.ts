import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_LIMIT, MAX_LIMIT, MAX_OFFSET } from "../../contract";
import { DatabasePluginError } from "../../errors";
import {
  bigid,
  boolean,
  defineSchema,
  fk,
  id,
  text,
  uuid,
} from "../../schema-builder";
import type { Row } from "../data-path";
import {
  createDrizzleDataPath,
  createDrizzleDb,
  type DrizzleDb,
  type DrizzleDataPathOptions,
} from "../engine/drizzle-data-path";
import { returningColumns } from "../engine/translate";

const schema = defineSchema((builder) => {
  const users = builder.table("users", {
    id: id(),
    email: text().unique(),
    name: text(),
    active: boolean(),
    secret: text().private(),
  });
  const posts = builder.table("posts", {
    id: id(),
    authorId: fk(() => users.id),
    title: text(),
    secret: text().private(),
  });
  return { users, posts };
});

const users = schema.$tables.users;
const naturalKeySchema = defineSchema((builder) => ({
  accounts: builder.table("accounts", {
    slug: text().primaryKey(),
    email: text().notNull().unique(),
    label: text().notNull(),
  }),
}));
const accounts = naturalKeySchema.$tables.accounts;
const dialect = new PgDialect();

function render(fragment: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment as SQL);
  return { sql: query.sql, params: query.params as unknown[] };
}

interface FakeResults {
  findMany?: Row[];
  findFirst?: Row;
  count?: number;
  insert?: Row[];
  update?: Row[];
  upsert?: Row[];
  delete?: Row[];
  execute?: unknown;
  transactionFailure?: "begin" | "commit" | "rollback";
  transactionError?: unknown;
}

interface FakeCalls {
  findMany: { table: string; config: Record<string, unknown> }[];
  findFirst: { table: string; config: Record<string, unknown> }[];
  count: { table: unknown; filter: unknown }[];
  insert: { table: unknown; values: Row; returning: unknown }[];
  update: { table: unknown; values: Row; where: unknown; returning: unknown }[];
  upsert: {
    table: unknown;
    values: Row;
    config: { target: unknown; set: Row };
    returning: unknown;
  }[];
  delete: { table: unknown; where: unknown; returning: unknown }[];
  execute: unknown[];
  transactions: number;
}

function makeFakeDb(results: FakeResults = {}): {
  db: DrizzleDb;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    findMany: [],
    findFirst: [],
    count: [],
    insert: [],
    update: [],
    upsert: [],
    delete: [],
    execute: [],
    transactions: 0,
  };
  const query = Object.fromEntries(
    Object.keys(schema.$tables).map((table) => [
      table,
      {
        async findMany(config: Record<string, unknown>) {
          calls.findMany.push({ table, config });
          return results.findMany ?? [];
        },
        async findFirst(config: Record<string, unknown>) {
          calls.findFirst.push({ table, config });
          return results.findFirst;
        },
      },
    ]),
  );

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
            async returning(returning: unknown) {
              calls.insert.push({ table, values, returning });
              return results.insert ?? [];
            },
            onConflictDoUpdate(config: { target: unknown; set: Row }) {
              return {
                async returning(returning: unknown) {
                  calls.upsert.push({ table, values, config, returning });
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
                async returning(returning: unknown) {
                  calls.update.push({ table, values, where, returning });
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
      calls.execute.push(fragment);
      return results.execute ?? { rows: [] };
    },
    async transaction(callback: (tx: unknown) => unknown) {
      calls.transactions += 1;
      if (results.transactionFailure === "begin") {
        throw results.transactionError;
      }
      try {
        const value = await callback(db);
        if (results.transactionFailure === "commit") {
          throw results.transactionError;
        }
        return value;
      } catch (error) {
        if (results.transactionFailure === "rollback") {
          throw results.transactionError;
        }
        throw error;
      }
    },
  };
  return { db: db as unknown as DrizzleDb, calls };
}

describe("createDrizzleDataPath reads", () => {
  it("translates bounded reads with a private-safe default projection", async () => {
    const fake = makeFakeDb({ findMany: [{ id: 1, name: "Ada" }] });
    const dataPath = createDrizzleDataPath(fake.db, schema);
    await expect(
      dataPath.select(users, {
        where: { active: true },
        order: { name: "asc" },
        include: { posts: true },
        offset: 2,
      }),
    ).resolves.toEqual([{ id: 1, name: "Ada" }]);

    const config = fake.calls.findMany[0].config;
    expect(config.limit).toBe(DEFAULT_LIMIT);
    expect(config.offset).toBe(2);
    expect(config.columns).toEqual({
      id: true,
      email: true,
      name: true,
      active: true,
    });
    expect(config.with).toEqual({
      posts: {
        columns: { id: true, authorId: true, title: true },
        limit: DEFAULT_LIMIT,
      },
    });
    expect(render(config.where).params).toEqual([true]);
  });

  it("supports explicit public selection and rejects excessive limits", async () => {
    const fake = makeFakeDb();
    const dataPath = createDrizzleDataPath(fake.db, schema);
    await dataPath.select(users, {
      select: ["id", "name"],
      limit: MAX_LIMIT,
    });
    expect(fake.calls.findMany[0].config.columns).toEqual({
      id: true,
      name: true,
    });
    await expect(
      dataPath.select(users, { limit: MAX_LIMIT + 1 }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      dataPath.select(users, { offset: MAX_OFFSET + 1 }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
  });

  it("denies private read fields by default and requires trusted access", async () => {
    const fake = makeFakeDb();
    const publicDataPath = createDrizzleDataPath(fake.db, schema);
    await expect(
      publicDataPath.select(users, { select: ["secret"] }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      publicDataPath.select(users, { where: { secret: "hidden" } }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      publicDataPath.select(users, { order: { secret: "asc" } }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      publicDataPath.select(users, {
        include: { posts: { select: ["secret"] } },
      }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    expect(fake.calls.findMany).toHaveLength(0);

    const trustedOptions = {
      columnAccess: "trusted",
    } satisfies DrizzleDataPathOptions;
    const trustedDataPath = createDrizzleDataPath(
      fake.db,
      schema,
      trustedOptions,
    );
    await trustedDataPath.select(users, {
      select: ["id", "secret"],
      where: { secret: "hidden" },
      order: { secret: "asc" },
      include: { posts: { select: ["id", "secret"] } },
    });
    const config = fake.calls.findMany[0].config;
    expect(config.columns).toEqual({ id: true, secret: true });
    expect(config.with).toEqual({
      posts: { columns: { id: true, secret: true }, limit: DEFAULT_LIMIT },
    });
    expect(render(config.where).params).toEqual(["hidden"]);
    expect(render((config.orderBy as unknown[])[0]).sql).toBe(
      `"users"."secret" asc`,
    );
  });

  it("finds by primary key and delegates count filters", async () => {
    const fake = makeFakeDb({ findFirst: { id: 7, name: "Ada" }, count: 3 });
    const dataPath = createDrizzleDataPath(fake.db, schema);
    await expect(
      dataPath.findOne(users, 7, {
        where: { active: true },
        select: ["id", "name"],
      }),
    ).resolves.toEqual({ id: 7, name: "Ada" });
    expect(render(fake.calls.findFirst[0].config.where).params).toEqual([
      7,
      true,
    ]);
    await expect(dataPath.count(users, { active: true })).resolves.toBe(3);
    expect(render(fake.calls.count[0].filter).params).toEqual([true]);
  });

  it("rejects table handles from another schema", async () => {
    const other = defineSchema((builder) => ({
      users: builder.table("users", { id: id() }),
    }));
    await expect(
      createDrizzleDataPath(makeFakeDb().db, schema).select(
        other.$tables.users,
        {},
      ),
    ).rejects.toBeInstanceOf(DatabasePluginError);
  });

  it.each([
    [
      "number",
      defineSchema(({ table }) => ({ users: table("users", { id: id() }) })),
      7,
      "7",
    ],
    [
      "bigint",
      defineSchema(({ table }) => ({ users: table("users", { id: bigid() }) })),
      7n,
      7,
    ],
    [
      "uuid",
      defineSchema(({ table }) => ({
        users: table("users", { id: uuid().primaryKey() }),
      })),
      "123e4567-e89b-42d3-a456-426614174000",
      "not-a-uuid",
    ],
    [
      "custom string",
      defineSchema(({ table }) => ({
        users: table("users", { id: text().primaryKey() }),
      })),
      "user-key",
      7,
    ],
  ] as const)(
    "validates %s primary-key IDs before builders",
    async (_kind, idSchema, valid, invalid) => {
      const fake = makeFakeDb({
        findFirst: { id: valid },
        update: [{ id: valid }],
        delete: [{ id: valid }],
      });
      const table = idSchema.$tables.users;
      const dataPath = createDrizzleDataPath(fake.db, idSchema);
      await expect(dataPath.findOne(table, valid, {})).resolves.toEqual({
        id: valid,
      });
      await expect(dataPath.update(table, valid, {})).resolves.toEqual({
        id: valid,
      });
      await expect(dataPath.delete(table, valid)).resolves.toBe(true);
      const before = {
        findFirst: fake.calls.findFirst.length,
        update: fake.calls.update.length,
        delete: fake.calls.delete.length,
      };
      await expect(
        dataPath.findOne(table, invalid as never, {}),
      ).rejects.toMatchObject({ category: "INVALID_REQUEST" });
      await expect(
        dataPath.update(table, invalid as never, {}),
      ).rejects.toMatchObject({ category: "INVALID_REQUEST" });
      await expect(
        dataPath.delete(table, invalid as never),
      ).rejects.toMatchObject({ category: "INVALID_REQUEST" });
      expect(fake.calls.findFirst).toHaveLength(before.findFirst);
      expect(fake.calls.update).toHaveLength(before.update);
      expect(fake.calls.delete).toHaveLength(before.delete);
    },
  );
});

describe("Drizzle mutation cardinality", () => {
  it("requires exactly one insert and upsert row", async () => {
    const row = { id: 1, email: "a@example.com" };
    await expect(
      createDrizzleDataPath(makeFakeDb({ insert: [row] }).db, schema).insert(
        users,
        { email: "a@example.com" },
      ),
    ).resolves.toEqual(row);
    await expect(
      createDrizzleDataPath(makeFakeDb({ insert: [] }).db, schema).insert(
        users,
        {},
      ),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      createDrizzleDataPath(
        makeFakeDb({ insert: [row, row] }).db,
        schema,
      ).insert(users, {}),
    ).rejects.toBeInstanceOf(DatabasePluginError);

    const fake = makeFakeDb({ upsert: [row] });
    await expect(
      createDrizzleDataPath(fake.db, schema).upsert(
        users,
        { email: "a@example.com" },
        "email",
      ),
    ).resolves.toEqual(row);
    expect(fake.calls.upsert[0].config.target).toBe(
      users.$columns.email.engineColumn,
    );
    expect(fake.calls.upsert[0].config.set).toEqual({
      email: users.$columns.email.engineColumn,
    });
    await expect(
      createDrizzleDataPath(fake.db, schema).upsert(users, {}, "name"),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      createDrizzleDataPath(makeFakeDb({ upsert: [] }).db, schema).upsert(
        users,
        { email: "a@example.com" },
        "email",
      ),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      createDrizzleDataPath(
        makeFakeDb({ upsert: [row, row] }).db,
        schema,
      ).upsert(users, { email: "a@example.com" }, "email"),
    ).rejects.toBeInstanceOf(DatabasePluginError);
  });

  it("rejects unknown identifiers and structural Drizzle mutation values", async () => {
    const fake = makeFakeDb({ insert: [{ id: 1 }] });
    const dataPath = createDrizzleDataPath(fake.db, schema);

    await expect(
      dataPath.insert(users, { missing: "not a schema column" }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      dataPath.insert(users, { name: drizzleSql.raw("current_user") }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      dataPath.update(users, 1, { name: users.$columns.email.engineColumn }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      dataPath.upsert(
        users,
        { email: "a@example.com", name: drizzleSql.raw("current_user") },
        "email",
      ),
    ).rejects.toBeInstanceOf(DatabasePluginError);

    expect(fake.calls.insert).toHaveLength(0);
    expect(fake.calls.update).toHaveLength(0);
    expect(fake.calls.upsert).toHaveLength(0);
  });

  it("revalidates mutation values against finalized write schemas", async () => {
    const fake = makeFakeDb();
    const dataPath = createDrizzleDataPath(fake.db, schema);

    await expect(
      dataPath.insert(users, { id: 10, email: "a@example.com" }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(dataPath.insert(users, { email: 42 })).rejects.toBeInstanceOf(
      DatabasePluginError,
    );
    await expect(dataPath.update(users, 1, { id: 2 })).rejects.toBeInstanceOf(
      DatabasePluginError,
    );
    await expect(
      dataPath.update(users, 1, { active: "yes" }),
    ).rejects.toBeInstanceOf(DatabasePluginError);
    await expect(
      dataPath.upsert(users, { id: 10, email: "a@example.com" }, "email"),
    ).rejects.toBeInstanceOf(DatabasePluginError);

    expect(fake.calls.insert).toHaveLength(0);
    expect(fake.calls.update).toHaveLength(0);
    expect(fake.calls.upsert).toHaveLength(0);
  });

  it("keeps natural keys out of the update half of an upsert", async () => {
    const fake = makeFakeDb({
      upsert: [{ slug: "existing", email: "a@example.com", label: "New" }],
    });
    await createDrizzleDataPath(fake.db, naturalKeySchema).upsert(
      accounts,
      { slug: "replacement", email: "a@example.com", label: "New" },
      "email",
    );

    expect(fake.calls.upsert[0].values).toEqual({
      slug: "replacement",
      email: "a@example.com",
      label: "New",
    });
    expect(fake.calls.upsert[0].config.set).toEqual({ label: "New" });
    expect(fake.calls.upsert[0].config.set).not.toHaveProperty("slug");
    expect(fake.calls.upsert[0].config.set).not.toHaveProperty("email");
  });

  it("accepts zero or one update row and rejects more", async () => {
    const row = { id: 1, name: "Updated" };
    await expect(
      createDrizzleDataPath(makeFakeDb({ update: [row] }).db, schema).update(
        users,
        1,
        { name: "Updated" },
      ),
    ).resolves.toEqual(row);
    await expect(
      createDrizzleDataPath(makeFakeDb({ update: [] }).db, schema).update(
        users,
        1,
        {},
      ),
    ).resolves.toBeNull();
    await expect(
      createDrizzleDataPath(
        makeFakeDb({ update: [row, row] }).db,
        schema,
      ).update(users, 1, {}),
    ).rejects.toBeInstanceOf(DatabasePluginError);
  });

  it("omits private columns from mutation returning projections and results", async () => {
    const leaked = { id: 1, email: "a@example.com", secret: "hashed" };
    const publicRow = { id: 1, email: "a@example.com" };

    const insertFake = makeFakeDb({ insert: [leaked] });
    await expect(
      createDrizzleDataPath(insertFake.db, schema).insert(users, {
        email: "a@example.com",
        secret: "hashed",
      }),
    ).resolves.toEqual(publicRow);
    expect(insertFake.calls.insert[0].returning).toEqual(
      returningColumns(users),
    );
    expect(insertFake.calls.insert[0].returning).not.toHaveProperty("secret");

    const updateFake = makeFakeDb({ update: [leaked] });
    await expect(
      createDrizzleDataPath(updateFake.db, schema).update(users, 1, {
        name: "Ada",
      }),
    ).resolves.toEqual(publicRow);
    expect(updateFake.calls.update[0].returning).toEqual(
      returningColumns(users),
    );

    const upsertFake = makeFakeDb({ upsert: [leaked] });
    await expect(
      createDrizzleDataPath(upsertFake.db, schema).upsert(
        users,
        { email: "a@example.com" },
        "email",
      ),
    ).resolves.toEqual(publicRow);
    expect(upsertFake.calls.upsert[0].returning).toEqual(
      returningColumns(users),
    );

    const trustedFake = makeFakeDb({ insert: [leaked] });
    await expect(
      createDrizzleDataPath(trustedFake.db, schema, {
        columnAccess: "trusted",
      }).insert(users, {
        email: "a@example.com",
        secret: "hashed",
      }),
    ).resolves.toEqual(leaked);
    expect(trustedFake.calls.insert[0].returning).toEqual(
      returningColumns(users, "trusted"),
    );
    expect(trustedFake.calls.insert[0].returning).toHaveProperty("secret");
  });

  it("accepts zero or one delete row and rejects more", async () => {
    await expect(
      createDrizzleDataPath(
        makeFakeDb({ delete: [{ id: 1 }] }).db,
        schema,
      ).delete(users, 1),
    ).resolves.toBe(true);
    await expect(
      createDrizzleDataPath(makeFakeDb({ delete: [] }).db, schema).delete(
        users,
        1,
      ),
    ).resolves.toBe(false);
    await expect(
      createDrizzleDataPath(
        makeFakeDb({ delete: [{ id: 1 }, { id: 2 }] }).db,
        schema,
      ).delete(users, 1),
    ).rejects.toBeInstanceOf(DatabasePluginError);
  });
});

describe("tagged SQL and transactions", () => {
  it("parameterizes tagged values and rejects structural interpolation", async () => {
    const fake = makeFakeDb({ execute: { rows: [{ total: 1 }] } });
    const dataPath = createDrizzleDataPath(fake.db, schema);
    const malicious = "1; drop table users";
    await expect(
      dataPath.raw`select count(*) as total from users where id = ${malicious}`,
    ).resolves.toEqual([{ total: 1 }]);
    const query = render(fake.calls.execute[0]);
    expect(query.sql).toContain("$1");
    expect(query.sql).not.toContain("drop table");
    expect(query.params).toEqual([malicious]);

    await expect(
      dataPath.raw`select ${drizzleSql.raw("drop table users")}`,
    ).rejects.toBeInstanceOf(DatabasePluginError);
    expect(fake.calls.execute).toHaveLength(1);
  });

  it("binds a DataPath to the Drizzle transaction and preserves callback errors", async () => {
    const fake = makeFakeDb({ insert: [{ id: 1 }] });
    const dataPath = createDrizzleDataPath(fake.db, schema);
    await expect(
      dataPath.transaction((transaction) => transaction.insert(users, {})),
    ).resolves.toEqual({ id: 1 });
    expect(fake.calls.transactions).toBe(1);

    const callbackError = new Error("application callback failed");
    await expect(
      dataPath.transaction(async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    const classifiedError = new DatabasePluginError(
      "INVALID_REQUEST",
      "runtime",
    );
    await expect(
      dataPath.transaction(async () => {
        throw classifiedError;
      }),
    ).rejects.toBe(classifiedError);

    const trustedDataPath = createDrizzleDataPath(fake.db, schema, {
      columnAccess: "trusted",
    });
    await expect(
      trustedDataPath.transaction((transaction) =>
        transaction.select(users, { select: ["secret"] }),
      ),
    ).resolves.toEqual([]);
    expect(fake.calls.findMany.at(-1)?.config.columns).toEqual({
      secret: true,
    });
  });

  it.each(["begin", "commit", "rollback"] as const)(
    "sanitizes Drizzle %s failures",
    async (transactionFailure) => {
      const rawError = new Error(`${transactionFailure} leaked driver detail`);
      const dataPath = createDrizzleDataPath(
        makeFakeDb({ transactionFailure, transactionError: rawError }).db,
        schema,
      );

      const error = await dataPath
        .transaction(async () => {
          if (transactionFailure === "rollback") {
            throw new Error("application callback failed");
          }
          return "done";
        })
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(DatabasePluginError);
      expect(error.message).toBe("Database operation failed");
      expect(error.cause).toBeUndefined();
    },
  );
});

describe("database failures", () => {
  it("does not retain raw driver details", async () => {
    const fake = makeFakeDb();
    const query = fake.db.query as unknown as Record<
      string,
      { findMany: () => Promise<Row[]> }
    >;
    query.users.findMany = async () => {
      throw new Error("constraint users_email_key contains a secret");
    };

    const error = await createDrizzleDataPath(fake.db, schema)
      .select(users, {})
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(DatabasePluginError);
    expect(error.message).toBe("Database operation failed");
    expect(error.cause).toBeUndefined();
  });

  it.each([
    ["23505", "CONFLICT", false],
    ["23000", "CONFLICT", false],
    ["40001", "TRANSIENT", true],
    ["40P01", "TRANSIENT", true],
    ["42501", "FORBIDDEN", false],
    ["XX000", "INTERNAL", false],
    [42, "INTERNAL", false],
  ] as const)(
    "maps SQLSTATE %s without leaking driver fields",
    async (code, category, isRetryable) => {
      const fake = makeFakeDb();
      const query = fake.db.query as unknown as Record<
        string,
        { findMany: () => Promise<Row[]> }
      >;
      query.users.findMany = async () => {
        throw {
          code,
          message: "password and SQL leaked",
          constraint: "users_secret_key",
          detail: "input secret",
        };
      };
      const error = await createDrizzleDataPath(fake.db, schema)
        .select(users, {})
        .catch((caught) => caught);
      expect(error).toMatchObject({
        category,
        isRetryable,
      });
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("secret");
    },
  );

  // Drizzle never rethrows the raw driver error; it wraps it in
  // DrizzleQueryError and moves the SQLSTATE onto `cause`.
  it.each([
    ["23503", "CONFLICT", false],
    ["40001", "TRANSIENT", true],
    ["40P01", "TRANSIENT", true],
    ["42501", "FORBIDDEN", false],
    ["XX000", "INTERNAL", false],
  ] as const)(
    "maps SQLSTATE %s carried on a wrapped driver cause",
    async (code, category, isRetryable) => {
      const fake = makeFakeDb();
      const query = fake.db.query as unknown as Record<
        string,
        { findMany: () => Promise<Row[]> }
      >;
      query.users.findMany = async () => {
        const driver = Object.assign(new Error("secret constraint detail"), {
          code,
          constraint: "users_secret_key",
        });
        throw Object.assign(
          new Error("Failed query: select secret from users"),
          { cause: driver },
        );
      };
      const error = await createDrizzleDataPath(fake.db, schema)
        .select(users, {})
        .catch((caught) => caught);
      expect(error).toMatchObject({ category, isRetryable });
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("secret");
    },
  );

  it("logs only safe driver classification metadata", async () => {
    const fake = makeFakeDb();
    const query = fake.db.query as unknown as Record<
      string,
      { findMany: () => Promise<Row[]> }
    >;
    query.users.findMany = async () => {
      throw {
        code: "23505",
        detail: "Key (email)=(alice@x.com) already exists",
      };
    };
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await createDrizzleDataPath(fake.db, schema)
        .select(users, {})
        .catch(() => undefined);

      const output = errorLog.mock.calls.flat().map(String).join(" ");
      expect(output).toContain("CONFLICT");
      expect(output).toContain("23505");
      expect(output).not.toContain("alice@x.com");
    } finally {
      errorLog.mockRestore();
    }
  });

  it("stops walking an error cause cycle", async () => {
    const fake = makeFakeDb();
    const query = fake.db.query as unknown as Record<
      string,
      { findMany: () => Promise<Row[]> }
    >;
    query.users.findMany = async () => {
      const cyclic: { cause?: unknown } = {};
      cyclic.cause = cyclic;
      throw cyclic;
    };
    const error = await createDrizzleDataPath(fake.db, schema)
      .select(users, {})
      .catch((caught) => caught);
    expect(error).toMatchObject({ category: "INTERNAL" });
  });

  it.each([
    Object.defineProperty({}, "code", {
      get: () => {
        throw new Error("getter secret");
      },
    }),
    new Proxy(
      {},
      {
        get: () => {
          throw new Error("proxy secret");
        },
      },
    ),
  ])("fails closed for hostile SQLSTATE access", async (hostile) => {
    const fake = makeFakeDb();
    const query = fake.db.query as unknown as Record<
      string,
      { findMany: () => Promise<Row[]> }
    >;
    query.users.findMany = async () => {
      throw hostile;
    };
    const error = await createDrizzleDataPath(fake.db, schema)
      .select(users, {})
      .catch((caught) => caught);
    expect(error).toMatchObject({
      category: "INTERNAL",
      message: "Database operation failed",
    });
    expect(error.cause).toBeUndefined();
  });
});

describe("createDrizzleDb", () => {
  let pool: Pool | undefined;
  afterAll(async () => {
    await pool?.end();
  });

  it("registers canonical tables and relations without connecting", () => {
    pool = new Pool();
    const db = createDrizzleDb(pool, schema);
    const query = db.query as unknown as Record<
      string,
      Record<string, unknown>
    >;
    expect(typeof query.users.findMany).toBe("function");
    expect(typeof query.posts.findFirst).toBe("function");
  });

  it("parameterizes ordinary mutation values", () => {
    pool ??= new Pool();
    const db = createDrizzleDb(pool, schema);
    const malicious = "x'); drop table users; --";
    const query = db
      .insert(users.$engine as unknown as PgTable)
      .values({ name: malicious })
      .toSQL();

    expect(query.sql).toContain("$1");
    expect(query.sql).not.toContain("drop table");
    expect(query.params).toContain(malicious);
  });
});
