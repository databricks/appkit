import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import {
  applyPendingMigrations,
  MigrationApplyError,
  MigrationHistoryError,
  markMigrationsApplied,
  migrationLockKey,
  readMigrationDrift,
} from "../apply";
import { MigrationFilesError } from "../paths";
import { hashOf, removeMigrationFolders, writeMigrations } from "./fixtures";

// A real server, for what a fake cannot show: transactions, enum rules, locks
// and catalogs. Point it at a scratch database, e.g.
// APPKIT_TEST_PG_URL=postgres://localhost:5432/postgres
const url = process.env.APPKIT_TEST_PG_URL;
const ROLE_PASSWORD = "appkit-test";

describe.skipIf(!url)("applyPendingMigrations against Postgres", () => {
  let admin: Pool;
  let schema: string;
  const pools: Pool[] = [];
  const held: PoolClient[] = [];

  const newPool = (config: { user?: string; max?: number } = {}) => {
    const target = new URL(url ?? "");
    if (config.user) {
      target.username = config.user;
      target.password = ROLE_PASSWORD;
    }
    const pool = new Pool({
      connectionString: target.toString(),
      max: config.max ?? 2,
    });
    pools.push(pool);
    return pool;
  };
  const q = (name: string) => `"${schema}"."${name}"`;
  const options = (folder: string) => ({
    migrationsFolder: folder,
    schemaName: schema,
  });
  const recorded = async () =>
    (
      await admin.query<{ hash: string; created_at: string }>(
        `select hash, created_at from ${q("__drizzle_migrations")} order by id`,
      )
    ).rows.map((row) => ({
      hash: row.hash,
      createdAt: Number(row.created_at),
    }));
  const columns = async (table: string) =>
    (
      await admin.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = $1 and table_name = $2 order by ordinal_position`,
        [schema, table],
      )
    ).rows.map((row) => row.column_name);

  beforeAll(() => {
    admin = new Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await admin.end();
  });
  beforeEach(() => {
    schema = `appkit_test_${randomUUID().slice(0, 8)}`;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    for (const client of held.splice(0)) client.release(true);
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await admin.query(`drop schema if exists "${schema}" cascade`);
    removeMigrationFolders();
    vi.restoreAllMocks();
  });

  const notes = () =>
    writeMigrations([
      {
        tag: "0000_notes",
        when: 1000,
        sql: [`CREATE TABLE ${q("notes")} ("id" integer PRIMARY KEY);`],
      },
      {
        tag: "0001_body",
        when: 2000,
        sql: [
          `ALTER TABLE ${q("notes")} ADD COLUMN "body" text;`,
          `ALTER TABLE ${q("notes")} ADD COLUMN "title" text;`,
        ],
      },
    ]);

  test("applies each migration once and records what drizzle-kit records", async () => {
    const folder = notes();
    const pool = newPool();

    const first = await applyPendingMigrations(pool, options(folder));
    const second = await applyPendingMigrations(pool, options(folder));

    expect(first.applied).toEqual(["0000_notes", "0001_body"]);
    expect(second.applied).toEqual([]);
    expect(await columns("notes")).toEqual(["id", "body", "title"]);
    expect(await recorded()).toEqual([
      { hash: hashOf(folder, "0000_notes"), createdAt: 1000 },
      { hash: hashOf(folder, "0001_body"), createdAt: 2000 },
    ]);
  });

  test("an enum value one migration adds can be used by the next one", async () => {
    // In one transaction for all, Postgres rejects this with 55P04.
    const folder = writeMigrations([
      {
        tag: "0000_mood",
        when: 1000,
        sql: [
          `CREATE TYPE ${q("mood")} AS ENUM ('ok');`,
          `CREATE TABLE ${q("notes")} ("id" integer, "mood" ${q("mood")});`,
        ],
      },
      {
        tag: "0001_great",
        when: 2000,
        sql: [`ALTER TYPE ${q("mood")} ADD VALUE 'great';`],
      },
      {
        tag: "0002_default",
        when: 3000,
        sql: [
          `ALTER TABLE ${q("notes")} ALTER COLUMN "mood" SET DEFAULT 'great';`,
        ],
      },
    ]);

    const result = await applyPendingMigrations(newPool(), options(folder));

    expect(result.applied).toEqual(["0000_mood", "0001_great", "0002_default"]);
  });

  test("a failing migration keeps the ones before it, and runs once it is fixed", async () => {
    const folder = writeMigrations([
      {
        tag: "0000_notes",
        when: 1000,
        sql: [`CREATE TABLE ${q("notes")} ("id" integer);`],
      },
      {
        tag: "0001_broken",
        when: 2000,
        sql: [`ALTER TABLE ${q("missing")} ADD COLUMN "x" integer;`],
      },
    ]);
    const pool = newPool();

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect(error).toMatchObject({
      failed: "0001_broken",
      applied: ["0000_notes"],
      code: "42P01",
    });
    expect(await columns("notes")).toEqual(["id"]);
    expect(await recorded()).toHaveLength(1);

    const fixed = writeMigrations([
      {
        tag: "0000_notes",
        when: 1000,
        sql: [`CREATE TABLE ${q("notes")} ("id" integer);`],
      },
      {
        tag: "0001_broken",
        when: 2000,
        sql: [`ALTER TABLE ${q("notes")} ADD COLUMN "x" integer;`],
      },
    ]);
    const result = await applyPendingMigrations(pool, options(fixed));
    expect(result.applied).toEqual(["0001_broken"]);
  });

  test("a migration merged behind the last recorded one fails closed and changes nothing", async () => {
    const a = {
      tag: "0000_a",
      when: 1000,
      sql: [`CREATE TABLE ${q("a")} ("id" integer);`],
    };
    const c = {
      tag: "0002_c",
      when: 3000,
      sql: [`CREATE TABLE ${q("c")} ("id" integer);`],
    };
    const pool = newPool();
    await applyPendingMigrations(pool, options(writeMigrations([a, c])));

    const merged = writeMigrations([
      a,
      {
        tag: "0001_b",
        when: 2000,
        sql: [`CREATE TABLE ${q("b")} ("id" integer);`],
      },
      c,
      {
        tag: "0003_d",
        when: 4000,
        sql: [`CREATE TABLE ${q("d")} ("id" integer);`],
      },
    ]);
    const error = await applyPendingMigrations(pool, options(merged)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationHistoryError);
    expect(error).toMatchObject({ stranded: ["0001_b"] });
    expect(await recorded()).toHaveLength(2);
    expect(await columns("d")).toEqual([]);
  });

  test("instances starting together apply each migration once", async () => {
    const folder = notes();

    const results = await Promise.all([
      applyPendingMigrations(newPool(), options(folder)),
      applyPendingMigrations(newPool(), options(folder)),
      applyPendingMigrations(newPool(), options(folder)),
    ]);

    expect(results.flatMap((result) => result.applied).sort()).toEqual([
      "0000_notes",
      "0001_body",
    ]);
    expect(await recorded()).toHaveLength(2);
  });

  test("the wait for another session's migration lock has a limit, and the error names the holder", async () => {
    const holder = await admin.connect();
    held.push(holder);
    await holder.query("set application_name = 'another-deploy'");
    await holder.query("select pg_advisory_lock($1::bigint)", [
      migrationLockKey(schema),
    ]);
    const pid = (
      await holder.query<{ pid: number }>("select pg_backend_pid() as pid")
    ).rows[0]?.pid;

    const error = await applyPendingMigrations(newPool(), {
      ...options(notes()),
      lockWaitMs: 300,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect((error as Error).message).toContain(
      `Session pid ${pid} (another-deploy, idle) held the migration lock for over 300ms.`,
    );
  });

  test("a table lock held elsewhere is retried, and the migration applies once it is released", async () => {
    const folder = notes();
    const pool = newPool();
    await applyPendingMigrations(pool, {
      ...options(
        writeMigrations([
          {
            tag: "0000_notes",
            when: 1000,
            sql: [`CREATE TABLE ${q("notes")} ("id" integer PRIMARY KEY);`],
          },
        ]),
      ),
    });
    const holder = await admin.connect();
    held.push(holder);
    await holder.query("begin");
    await holder.query(`lock table ${q("notes")} in access share mode`);
    setTimeout(() => void holder.query("commit"), 300);

    const result = await applyPendingMigrations(pool, {
      ...options(folder),
      lockTimeoutMs: 200,
    });

    expect(result.applied).toEqual(["0001_body"]);
    expect(console.warn).toHaveBeenCalled();
  });

  test("a table lock held through every try fails with 55P03 and leaves the migration unapplied", async () => {
    const pool = newPool();
    await applyPendingMigrations(pool, {
      ...options(
        writeMigrations([
          {
            tag: "0000_notes",
            when: 1000,
            sql: [`CREATE TABLE ${q("notes")} ("id" integer PRIMARY KEY);`],
          },
        ]),
      ),
    });
    const holder = await admin.connect();
    held.push(holder);
    await holder.query("begin");
    await holder.query(`lock table ${q("notes")} in access share mode`);

    const error = await applyPendingMigrations(pool, {
      ...options(notes()),
      lockTimeoutMs: 100,
    }).catch((caught: unknown) => caught);
    await holder.query("rollback");

    expect(error).toMatchObject({ failed: "0001_body", code: "55P03" });
    expect(await columns("notes")).toEqual(["id"]);
  });

  test("the session goes back to the pool reset and unlocked", async () => {
    const pool = newPool({ max: 1 });
    const before = await pool.query<{ application_name: string }>(
      "select current_setting('application_name') as application_name",
    );

    await applyPendingMigrations(pool, options(notes()));

    const after = await pool.query<{
      application_name: string;
      lock_timeout: string;
      locks: string;
    }>(
      `select current_setting('application_name') as application_name,
              current_setting('lock_timeout') as lock_timeout,
              (select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid())::text as locks`,
    );
    expect(after.rows[0]).toEqual({
      application_name: before.rows[0]?.application_name,
      lock_timeout: "0",
      locks: "0",
    });
  });

  test("an existing schema owned by another role: the error names both roles", async () => {
    const suffix = schema.slice(-8);
    const owner = `appkit_owner_${suffix}`;
    const app = `appkit_app_${suffix}`;
    await admin.query(`create role "${owner}" nologin`);
    await admin.query(`create role "${app}" login password '${ROLE_PASSWORD}'`);
    await admin.query(`create schema "${schema}" authorization "${owner}"`);
    try {
      const error = await applyPendingMigrations(
        newPool({ user: app }),
        options(notes()),
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "42501" });
      expect((error as Error).message).toContain(
        `Schema "${schema}" is owned by "${owner}", but the app connects as "${app}".`,
      );
    } finally {
      await Promise.all(pools.splice(0).map((pool) => pool.end()));
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.query(`drop owned by "${app}"`);
      await admin.query(`drop role "${app}"`);
      await admin.query(`drop role "${owner}"`);
    }
  });

  test("a baseline whose tables already exist is adopted, and later migrations apply", async () => {
    await admin.query(`create schema "${schema}"`);
    await admin.query(`create table ${q("notes")} ("id" integer primary key)`);
    const folder = writeMigrations(
      [
        {
          tag: "0000_baseline",
          when: 1000,
          sql: [`CREATE TABLE ${q("notes")} ("id" integer PRIMARY KEY);`],
          snapshot: { notes: ["id"] },
        },
        {
          tag: "0001_body",
          when: 2000,
          sql: [`ALTER TABLE ${q("notes")} ADD COLUMN "body" text;`],
        },
      ],
      schema,
    );

    const result = await applyPendingMigrations(newPool(), options(folder));

    expect(result).toMatchObject({
      adopted: ["0000_baseline"],
      applied: ["0001_body"],
    });
    expect(await columns("notes")).toEqual(["id", "body"]);
  });

  describe("recording migrations the branch already has", () => {
    const withTags = () =>
      writeMigrations([
        {
          tag: "0000_notes",
          when: 1000,
          sql: [`CREATE TABLE ${q("notes")} ("id" integer PRIMARY KEY);`],
        },
        {
          tag: "0001_introspect",
          when: 3000,
          sql: [`ALTER TABLE ${q("notes")} ADD COLUMN "body" text;`],
        },
      ]);
    /** The branch applied 0000_notes and recorded a 2000 migration this checkout lacks. */
    const aheadOfCheckout = async (folder: string) => {
      await applyPendingMigrations(newPool(), {
        ...options(folder),
        migrationsFolder: notes(),
      });
      await admin.query(
        `delete from ${q("__drizzle_migrations")} where created_at <> 1000`,
      );
      await admin.query(
        `insert into ${q("__drizzle_migrations")} (hash, created_at) values ('teammate', 2000)`,
      );
    };

    test("the drift lists unrecorded committed migrations and recorded ones the checkout lacks", async () => {
      const folder = withTags();
      expect(await readMigrationDrift(newPool(), options(folder))).toEqual({
        pending: ["0000_notes", "0001_introspect"],
        stranded: [],
        unknown: 0,
      });

      await aheadOfCheckout(folder);

      expect(await readMigrationDrift(newPool(), options(folder))).toEqual({
        pending: ["0001_introspect"],
        stranded: [],
        unknown: 1,
      });
    });

    test("records exactly the pending migrations, without running them", async () => {
      await admin.query(`create schema "${schema}"`);
      const folder = withTags();

      await markMigrationsApplied(newPool(), options(folder), [
        "0000_notes",
        "0001_introspect",
      ]);

      expect(await recorded()).toEqual([
        { hash: hashOf(folder, "0000_notes"), createdAt: 1000 },
        { hash: hashOf(folder, "0001_introspect"), createdAt: 3000 },
      ]);
      expect(await columns("notes")).toEqual([]);
    });

    test.each([
      [
        "records a migration the checkout lacks",
        aheadOfCheckout,
        ["0001_introspect"],
        "it records 1 migration this checkout does not have",
      ],
      [
        "has not applied an earlier one",
        async () => {
          await admin.query(`create schema "${schema}"`);
        },
        ["0001_introspect"],
        "it has not applied 0000_notes",
      ],
    ])(
      "refuses when the branch %s, and records nothing",
      async (_label, arrange, toRecord, reason) => {
        const folder = withTags();
        await arrange(folder);
        const before = await recorded().catch(() => []);

        await expect(
          markMigrationsApplied(newPool(), options(folder), toRecord),
        ).rejects.toThrow(
          `Schema "${schema}" changed while this ran (${reason}), so nothing was recorded.`,
        );
        expect(await recorded().catch(() => [])).toEqual(before);
      },
    );

    test("a tag missing from the journal fails before connecting", async () => {
      const pool = newPool();
      const connect = vi.spyOn(pool, "connect");

      await expect(
        markMigrationsApplied(pool, options(withTags()), ["0002_introspect"]),
      ).rejects.toBeInstanceOf(MigrationFilesError);
      expect(connect).not.toHaveBeenCalled();
    });

    test("the wait for the migration lock has a limit, and nothing is recorded", async () => {
      await admin.query(`create schema "${schema}"`);
      const holder = await admin.connect();
      held.push(holder);
      await holder.query("set application_name = 'another-deploy'");
      await holder.query("select pg_advisory_lock($1::bigint)", [
        migrationLockKey(schema),
      ]);

      await expect(
        markMigrationsApplied(
          newPool(),
          { ...options(withTags()), lockWaitMs: 300 },
          ["0000_notes", "0001_introspect"],
        ),
      ).rejects.toThrow(
        new RegExp(
          `^Session pid \\d+ \\(another-deploy, idle\\) held the migration lock of schema "${schema}" for over 300ms, so nothing was recorded\\. Rerun once it finishes\\.$`,
        ),
      );
      expect(await recorded().catch(() => [])).toEqual([]);
    });
  });
});
