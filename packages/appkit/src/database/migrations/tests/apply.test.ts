import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  applyPendingMigrations,
  MigrationApplyError,
  MigrationBaselineMismatchError,
  MigrationHistoryError,
  migrationLockKey,
} from "../apply";
import { MigrationFilesError } from "../paths";
import {
  hashOf,
  removeMigrationFolders,
  writeMigrations as migrations,
} from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  removeMigrationFolders();
});

interface JournalRow {
  hash: string;
  created_at: number | null;
}

interface FakeState {
  /** Rows of the journal table; null while the table does not exist. */
  recorded: JournalRow[] | null;
  failOn?: RegExp;
  /** SQLSTATE of the failOn error; defaults to 42P07 (duplicate_table). */
  failCode?: string;
  /** How many failOn matches fail before one succeeds; all of them when unset. */
  failTimes?: number;
  failCleanupOn?: RegExp;
  /** pg_catalog (table, column) pairs the baseline check sees. */
  catalog?: Array<[string, string]>;
  /** Another session holds the migration lock. */
  lockHeld?: boolean;
  lockHolder?: { pid: number; application_name: string; state: string };
  ownership?: { owner: string | null; current_user: string };
}

/**
 * A pg PoolClient that records every statement and keeps journal inserts
 * only when their transaction commits.
 */
class RecordingClient {
  readonly statements: string[] = [];
  released: { error: unknown } | undefined;
  private uncommitted: JournalRow[] | undefined;
  private failures = 0;

  constructor(private readonly state: FakeState) {}

  async query(
    input: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ) {
    const text = (typeof input === "string" ? input : input.text).trim();
    const params = values ?? (typeof input === "string" ? [] : input.values);
    this.statements.push(text);
    if (
      this.state.failOn?.test(text) &&
      (this.state.failTimes === undefined ||
        this.failures < this.state.failTimes)
    ) {
      this.failures++;
      throw Object.assign(new Error("statement failed"), {
        code: this.state.failCode ?? "42P07",
      });
    }
    if (this.state.failCleanupOn?.test(text)) {
      throw new Error("connection lost");
    }
    if (text === "begin") this.uncommitted = [];
    if (text === "commit") {
      if (this.uncommitted?.length) {
        this.state.recorded = [
          ...(this.state.recorded ?? []),
          ...this.uncommitted,
        ];
      }
      this.uncommitted = undefined;
    }
    if (text === "rollback") this.uncommitted = undefined;
    if (text.includes("pg_try_advisory_lock(")) {
      return { rows: [{ locked: !this.state.lockHeld }] };
    }
    if (text.includes("pg_catalog.pg_locks")) {
      return { rows: this.state.lockHolder ? [this.state.lockHolder] : [] };
    }
    if (text.includes("pg_get_userbyid")) {
      return {
        rows: [
          this.state.ownership ?? { owner: "app-sp", current_user: "app-sp" },
        ],
      };
    }
    if (text.includes("pg_catalog.pg_attribute")) {
      return {
        rows: (this.state.catalog ?? []).map(([table_name, column_name]) => ({
          table_name,
          column_name,
        })),
      };
    }
    if (text.includes("pg_catalog.pg_class")) {
      return { rows: this.state.recorded ? [{ one: 1 }] : [] };
    }
    if (text.startsWith("select hash, created_at")) {
      return { rows: this.state.recorded ?? [] };
    }
    if (text.startsWith(`insert into "app"."__drizzle_migrations"`)) {
      this.uncommitted?.push({
        hash: String(params?.[0]),
        created_at: Number(params?.[1]),
      });
    }
    return { rows: [] };
  }

  release(error?: unknown) {
    this.released = { error };
  }
}

function fakePool(state: FakeState) {
  const client = new RecordingClient(state);
  let connects = 0;
  return {
    client,
    state,
    connects: () => connects,
    pool: {
      connect: async () => {
        connects++;
        return client as never;
      },
    },
  };
}

const twoMigrations = () =>
  migrations([
    {
      tag: "0000_migration",
      when: 1000,
      sql: [`CREATE TABLE "app"."notes" ("id" integer);`],
    },
    {
      tag: "0001_migration",
      when: 2000,
      sql: [
        `ALTER TABLE "app"."notes" ADD COLUMN "body" text;`,
        `ALTER TABLE "app"."notes" ADD COLUMN "title" text;`,
      ],
    },
  ]);

const options = (folder: string) => ({
  migrationsFolder: folder,
  schemaName: "app",
});

/** Collapse the recorded statements into readable steps. */
function steps(statements: readonly string[]): string[] {
  return statements.map((statement) => {
    if (statement.includes("pg_try_advisory_lock(")) return "try lock";
    if (statement.includes("pg_advisory_unlock(")) return "unlock";
    if (statement.includes("pg_catalog.pg_locks")) return "lock holder?";
    if (statement.includes("pg_get_userbyid")) return "schema owner?";
    if (statement.includes("pg_catalog.pg_attribute"))
      return "baseline tables?";
    if (statement.includes("pg_catalog.pg_class")) return "journal table?";
    if (statement.startsWith("select hash, created_at")) return "recorded?";
    if (statement.startsWith(`CREATE SCHEMA IF NOT EXISTS`))
      return "create schema";
    if (statement.startsWith(`CREATE TABLE IF NOT EXISTS "app"."__drizzle`))
      return "create journal";
    if (statement.startsWith(`insert into "app"."__drizzle_migrations"`))
      return "record";
    return statement.replace(/\s+/g, " ");
  });
}

const SESSION_SETUP = [
  "SET statement_timeout = 0",
  "SET application_name = 'appkit-migrate'",
  "SET client_connection_check_interval = '10s'",
  "try lock",
  "SET lock_timeout = '5000ms'",
];

const SESSION_CLEANUP = [
  "unlock",
  "RESET lock_timeout",
  "RESET client_connection_check_interval",
  "RESET application_name",
  "RESET statement_timeout",
];

describe("applyPendingMigrations", () => {
  test("reads without the lock, then applies each pending migration in its own transaction under it", async () => {
    const folder = twoMigrations();
    const { pool, client, state } = fakePool({ recorded: null });

    const result = await applyPendingMigrations(pool, options(folder));

    expect(result).toEqual({
      applied: ["0000_migration", "0001_migration"],
      adopted: [],
      edited: [],
      unknown: 0,
      lockWaitMs: expect.any(Number),
    });
    expect(steps(client.statements)).toEqual([
      "journal table?",
      ...SESSION_SETUP,
      "journal table?",
      "begin",
      "create schema",
      "create journal",
      `CREATE TABLE "app"."notes" ("id" integer);`,
      "record",
      "commit",
      "begin",
      "create schema",
      "create journal",
      `ALTER TABLE "app"."notes" ADD COLUMN "body" text;`,
      `ALTER TABLE "app"."notes" ADD COLUMN "title" text;`,
      "record",
      "commit",
      ...SESSION_CLEANUP,
    ]);
    // The rows drizzle-orm's migrator would have written.
    expect(state.recorded).toEqual([
      { hash: hashOf(folder, "0000_migration"), created_at: 1000 },
      { hash: hashOf(folder, "0001_migration"), created_at: 2000 },
    ]);
    expect(client.released).toEqual({ error: undefined });
  });

  test("applies only migrations newer than the last recorded one", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      recorded: [{ hash: hashOf(folder, "0000_migration"), created_at: 1000 }],
    });

    const result = await applyPendingMigrations(pool, options(folder));

    expect(result.applied).toEqual(["0001_migration"]);
    expect(client.statements).not.toContain(
      `CREATE TABLE "app"."notes" ("id" integer);`,
    );
  });

  test("with nothing pending, it only reads: no lock, no session settings", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      recorded: [
        { hash: hashOf(folder, "0000_migration"), created_at: 1000 },
        { hash: hashOf(folder, "0001_migration"), created_at: 2000 },
      ],
    });

    const result = await applyPendingMigrations(pool, options(folder));

    expect(result.applied).toEqual([]);
    expect(steps(client.statements)).toEqual(["journal table?", "recorded?"]);
    expect(client.released).toEqual({ error: undefined });
  });

  test("another instance applied everything while this one waited: nothing runs twice", async () => {
    const folder = twoMigrations();
    const fake = fakePool({ recorded: null });
    const query = fake.client.query.bind(fake.client);
    vi.spyOn(fake.client, "query").mockImplementation(async (input, values) => {
      const result = await query(input, values);
      if (String(input).includes("pg_try_advisory_lock(")) {
        fake.state.recorded = [
          { hash: hashOf(folder, "0000_migration"), created_at: 1000 },
          { hash: hashOf(folder, "0001_migration"), created_at: 2000 },
        ];
      }
      return result;
    });

    const result = await applyPendingMigrations(fake.pool, options(folder));

    expect(result.applied).toEqual([]);
    expect(fake.client.statements).not.toContain("begin");
  });

  test("without a journal it never connects", async () => {
    const folder = migrations([]);
    fs.rmSync(path.join(folder, "meta"), { recursive: true });
    const fake = fakePool({ recorded: null });

    await expect(
      applyPendingMigrations(fake.pool, options(folder)),
    ).resolves.toEqual({
      applied: [],
      adopted: [],
      edited: [],
      unknown: 0,
      lockWaitMs: 0,
    });
    expect(fake.connects()).toBe(0);
  });

  test("a failing migration rolls back alone: the ones before it stay applied", async () => {
    const folder = twoMigrations();
    const { pool, client, state } = fakePool({
      recorded: null,
      failOn: /ADD COLUMN "title"/,
    });

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect(error).toMatchObject({
      failed: "0001_migration",
      applied: ["0000_migration"],
      pending: ["0001_migration"],
      code: "42P07",
    });
    expect((error as Error).message).toBe(
      "Migration 0001_migration failed (SQLSTATE 42P07) and was rolled back. Applied before the failure: 0000_migration. Not applied: 0001_migration.",
    );
    expect(state.recorded).toEqual([
      { hash: hashOf(folder, "0000_migration"), created_at: 1000 },
    ]);
    expect(steps(client.statements).slice(-6)).toEqual([
      "rollback",
      ...SESSION_CLEANUP,
    ]);
    expect(client.released).toEqual({ error: undefined });
  });

  test("a migration older than the last recorded one, never applied, fails closed before taking the lock", async () => {
    const folder = migrations([
      { tag: "0000_a", when: 1000, sql: [`SELECT 1;`] },
      { tag: "0001_parallel", when: 1500, sql: [`SELECT 2;`] },
      { tag: "0002_b", when: 2000, sql: [`SELECT 3;`] },
    ]);
    const { pool, client } = fakePool({
      recorded: [
        { hash: hashOf(folder, "0000_a"), created_at: 1000 },
        { hash: hashOf(folder, "0002_b"), created_at: 2000 },
      ],
    });

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationHistoryError);
    expect(error).toMatchObject({ stranded: ["0001_parallel"] });
    expect((error as Error).message).toMatch(
      /^Migration 0001_parallel is older than 0002_b, which schema "app" already recorded, and was never applied/,
    );
    expect(steps(client.statements)).toEqual(["journal table?", "recorded?"]);
  });

  test("a stranded migration also stops the pending ones after it", async () => {
    const folder = migrations([
      { tag: "0000_a", when: 1000, sql: [`SELECT 1;`] },
      { tag: "0001_parallel", when: 1500, sql: [`SELECT 2;`] },
      { tag: "0002_b", when: 2000, sql: [`SELECT 3;`] },
      { tag: "0003_c", when: 3000, sql: [`SELECT 4;`] },
    ]);
    const { pool, client } = fakePool({
      recorded: [
        { hash: hashOf(folder, "0000_a"), created_at: 1000 },
        { hash: hashOf(folder, "0002_b"), created_at: 2000 },
      ],
    });

    await expect(
      applyPendingMigrations(pool, options(folder)),
    ).rejects.toBeInstanceOf(MigrationHistoryError);
    expect(client.statements).not.toContain("SELECT 4;");
  });

  test("an applied migration whose file changed is logged, and its change does not run", async () => {
    const folder = twoMigrations();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pool } = fakePool({
      recorded: [
        { hash: "the-hash-before-the-edit", created_at: 1000 },
        { hash: hashOf(folder, "0001_migration"), created_at: 2000 },
      ],
    });

    const result = await applyPendingMigrations(pool, options(folder));

    expect(result).toMatchObject({ applied: [], edited: ["0000_migration"] });
    expect(warn.mock.calls.flat().map(String).join(" ")).toContain(
      "Migrations 0000_migration changed after schema app applied them",
    );
  });

  test("recorded migrations that are not committed here are logged", async () => {
    const folder = twoMigrations();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pool } = fakePool({
      recorded: [
        { hash: hashOf(folder, "0000_migration"), created_at: 1000 },
        { hash: hashOf(folder, "0001_migration"), created_at: 2000 },
        { hash: "from-a-newer-release", created_at: 3000 },
      ],
    });

    const result = await applyPendingMigrations(pool, options(folder));

    expect(result).toMatchObject({ applied: [], unknown: 1 });
    expect(warn.mock.calls.flat().map(String).join(" ")).toContain(
      "Schema app recorded 1 migration(s) that are not committed here",
    );
  });

  test("a table lock not granted in time is retried, then fails with the hint", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      recorded: [{ hash: hashOf(folder, "0000_migration"), created_at: 1000 }],
      failOn: /ADD COLUMN "body"/,
      failCode: "55P03",
    });

    const error = await applyPendingMigrations(pool, {
      ...options(folder),
      lockTimeoutMs: 1,
    }).catch((caught: unknown) => caught);

    expect(client.statements.filter((s) => s === "rollback")).toHaveLength(3);
    expect((error as Error).message).toBe(
      "Migration 0001_migration failed (SQLSTATE 55P03) and was rolled back. Not applied: 0001_migration. " +
        "Another session held a lock on a table this migration changes for over 1ms, 3 times. Deploy again once the long-running query or transaction finishes.",
    );
  });

  test("a table lock granted on the retry applies the migration", async () => {
    const folder = twoMigrations();
    const { pool } = fakePool({
      recorded: [{ hash: hashOf(folder, "0000_migration"), created_at: 1000 }],
      failOn: /ADD COLUMN "body"/,
      failCode: "55P03",
      failTimes: 1,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await applyPendingMigrations(pool, {
      ...options(folder),
      lockTimeoutMs: 1,
    });

    expect(result.applied).toEqual(["0001_migration"]);
  });

  test("the wait for another session's migration lock has a limit, and the error names the holder", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      recorded: null,
      lockHeld: true,
      lockHolder: {
        pid: 42,
        application_name: "appkit-migrate",
        state: "active",
      },
    });

    const error = await applyPendingMigrations(pool, {
      ...options(folder),
      lockWaitMs: 0,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect((error as Error).message).toBe(
      "Waiting for the migration lock failed. Not applied: 0000_migration, 0001_migration. " +
        "Session pid 42 (appkit-migrate, active) held the migration lock for over 0ms. Deploy again once it finishes; if it is stuck, end it with pg_terminate_backend.",
    );
    // Never locked, so never unlocked; the session settings are still reset.
    expect(steps(client.statements).slice(-3)).toEqual([
      "RESET client_connection_check_interval",
      "RESET application_name",
      "RESET statement_timeout",
    ]);
  });

  test("a server that cannot check client connections still migrates", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      recorded: null,
      failOn: /client_connection_check_interval/,
      failCode: "22023",
    });

    const result = await applyPendingMigrations(pool, options(folder));

    expect(result.applied).toHaveLength(2);
    expect(client.statements).not.toContain(
      "RESET client_connection_check_interval",
    );
  });

  test("an ownership failure (42501) names the schema owner and the connecting role", async () => {
    const folder = twoMigrations();
    const { pool } = fakePool({
      recorded: null,
      failOn: /CREATE TABLE "app"."notes"/,
      failCode: "42501",
      ownership: { owner: "old-app-sp", current_user: "new-app-sp" },
    });

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "42501" });
    expect((error as Error).message).toContain(
      `Schema "app" is owned by "old-app-sp", but the app connects as "new-app-sp".`,
    );
  });

  test("reading the recorded migrations fails (42501): the hint, and nothing applied", async () => {
    const folder = twoMigrations();
    const { pool } = fakePool({
      recorded: [],
      failOn: /^select hash, created_at/,
      failCode: "42501",
      ownership: { owner: "someone-else", current_user: "app-sp" },
    });

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ pending: [], code: "42501" });
    expect((error as Error).message).toMatch(
      /^Reading the recorded migrations failed \(SQLSTATE 42501\)\. No migration was applied\. Schema "app" is owned by "someone-else"/,
    );
  });

  test("a connection failure carries the system error code", async () => {
    const folder = twoMigrations();
    const pool = {
      connect: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      },
    };

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect(error).toMatchObject({ code: undefined });
    expect((error as Error).message).toBe(
      "Connecting to the database failed (ECONNREFUSED). No migration was applied.",
    );
  });

  test("a Node system error is not reported as a SQLSTATE", async () => {
    const folder = twoMigrations();
    const { pool } = fakePool({
      recorded: [{ hash: hashOf(folder, "0000_migration"), created_at: 1000 }],
      failOn: /ADD COLUMN "body"/,
      failCode: "EPIPE",
    });

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: undefined });
    expect((error as Error).message).toBe(
      "Migration 0001_migration failed (EPIPE) and was rolled back. Not applied: 0001_migration.",
    );
  });

  test("a failed unlock destroys the connection instead of returning it to the pool", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      recorded: null,
      failCleanupOn: /pg_advisory_unlock/,
    });

    await applyPendingMigrations(pool, options(folder));

    // The remaining cleanup still runs.
    expect(steps(client.statements).slice(-5)).toEqual(SESSION_CLEANUP);
    expect(client.released?.error).toBeInstanceOf(Error);
  });

  test("a missing .sql file fails before connecting, naming the file", async () => {
    const folder = twoMigrations();
    fs.rmSync(path.join(folder, "0001_migration.sql"));
    const fake = fakePool({ recorded: null });

    const error = await applyPendingMigrations(
      fake.pool,
      options(folder),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationFilesError);
    expect((error as Error).message).toMatch(
      /^Missing .*0001_migration\.sql, listed in meta\/_journal\.json\. Restore it from version control\.$/,
    );
    expect(fake.connects()).toBe(0);
  });

  test.each([
    [
      "not JSON",
      "{",
      /^Cannot read .*_journal\.json: .*Restore it from version control\.$/,
    ],
    [
      "another dialect",
      JSON.stringify({ version: "7", dialect: "mysql", entries: [] }),
      /_journal\.json is not a drizzle-kit PostgreSQL migration journal$/,
    ],
  ])(
    "a journal that is %s fails before connecting, naming the file",
    async (_label, contents, message) => {
      const folder = twoMigrations();
      fs.writeFileSync(path.join(folder, "meta/_journal.json"), contents);
      const fake = fakePool({ recorded: null });

      const error = await applyPendingMigrations(
        fake.pool,
        options(folder),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MigrationFilesError);
      expect((error as Error).message).toMatch(message);
      expect(fake.connects()).toBe(0);
    },
  );
});

describe("migrationLockKey", () => {
  test("is a stable signed 64-bit key per schema", () => {
    const key = migrationLockKey("app");
    expect(key).toBe(migrationLockKey("app"));
    expect(key).not.toBe(migrationLockKey("public"));
    const value = BigInt(key);
    expect(value).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(value).toBeLessThan(2n ** 63n);
  });
});

const BASELINE_SQL = [
  `CREATE TABLE "app"."notes" ("id" integer PRIMARY KEY, "body" text);`,
  `CREATE TABLE "app"."tags" ("id" integer PRIMARY KEY);`,
];

/** 0000_baseline (notes, tags) followed by one ordinary migration. */
const baselineThenMigration = () =>
  migrations([
    {
      tag: "0000_baseline",
      when: 1000,
      sql: BASELINE_SQL,
      snapshot: { notes: ["id", "body"], tags: ["id"] },
    },
    {
      tag: "0001_migration",
      when: 2000,
      sql: [`ALTER TABLE "app"."notes" ADD COLUMN "title" text;`],
      snapshot: { notes: ["id", "body", "title"], tags: ["id"] },
    },
  ]);

const BASELINE_CATALOG: Array<[string, string]> = [
  ["notes", "id"],
  ["notes", "body"],
  ["tags", "id"],
];

describe("applyPendingMigrations — baseline adoption", () => {
  test("none of the baseline's tables exist: the baseline runs like any migration", async () => {
    const folder = baselineThenMigration();
    const { pool, client } = fakePool({ recorded: null, catalog: [] });

    const result = await applyPendingMigrations(pool, options(folder));

    expect(result).toMatchObject({
      applied: ["0000_baseline", "0001_migration"],
      adopted: [],
    });
    expect(client.statements).toContain(BASELINE_SQL[0]);
  });

  test("every baseline table and column exists: the baseline is recorded, not run, and later migrations apply", async () => {
    const folder = baselineThenMigration();
    const { pool, client, state } = fakePool({
      recorded: null,
      catalog: BASELINE_CATALOG,
    });

    const result = await applyPendingMigrations(pool, options(folder));

    expect(result).toMatchObject({
      applied: ["0001_migration"],
      adopted: ["0000_baseline"],
    });
    expect(client.statements).not.toContain(BASELINE_SQL[0]);
    expect(client.statements).toContain(
      `ALTER TABLE "app"."notes" ADD COLUMN "title" text;`,
    );
    // The adopted row carries exactly what drizzle-orm's migrator would have written.
    expect(state.recorded?.[0]).toEqual({
      hash: hashOf(folder, "0000_baseline"),
      created_at: 1000,
    });
  });

  test("adopting a lone baseline applies nothing else", async () => {
    const folder = migrations([
      {
        tag: "0000_baseline",
        when: 1000,
        sql: BASELINE_SQL,
        snapshot: { notes: ["id", "body"], tags: ["id"] },
      },
    ]);
    const { pool } = fakePool({ recorded: null, catalog: BASELINE_CATALOG });

    await expect(
      applyPendingMigrations(pool, options(folder)),
    ).resolves.toMatchObject({ applied: [], adopted: ["0000_baseline"] });
  });

  test("only part of the baseline exists: MigrationBaselineMismatchError, nothing recorded or run", async () => {
    const folder = baselineThenMigration();
    const { pool, client, state } = fakePool({
      recorded: null,
      catalog: [["notes", "id"]],
    });

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationBaselineMismatchError);
    expect((error as MigrationBaselineMismatchError).problems).toEqual([
      "table app.notes is missing column body",
      "table app.tags does not exist",
    ]);
    expect((error as Error).message).toMatch(
      /^Cannot adopt 0000_baseline: schema "app" has no recorded migrations and only part of the baseline: /,
    );
    expect(state.recorded).toBeNull();
    expect(client.statements).not.toContain("begin");
    expect(client.released).toEqual({ error: undefined });
  });

  test("recording the adopted baseline fails: MigrationApplyError with the SQLSTATE and the ownership hint", async () => {
    const folder = baselineThenMigration();
    const { pool, client } = fakePool({
      recorded: null,
      catalog: BASELINE_CATALOG,
      // The schema belongs to another role, so the journal table cannot be created in it.
      failOn: /^CREATE TABLE IF NOT EXISTS "app"\."__drizzle_migrations"/,
      failCode: "42501",
      ownership: { owner: "someone-else", current_user: "app-sp" },
    });

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect(error).toMatchObject({
      failed: "0000_baseline",
      pending: ["0000_baseline", "0001_migration"],
      code: "42501",
    });
    expect((error as Error).message).toContain(
      `Schema "app" is owned by "someone-else"`,
    );
    expect(client.statements).toContain("rollback");
    expect(client.statements).not.toContain(
      `ALTER TABLE "app"."notes" ADD COLUMN "title" text;`,
    );
  });

  test("with a recorded migration, the baseline is never adopted", async () => {
    const folder = baselineThenMigration();
    const { pool, client } = fakePool({
      recorded: [{ hash: hashOf(folder, "0000_baseline"), created_at: 1000 }],
      catalog: [["notes", "id"]],
    });

    await expect(
      applyPendingMigrations(pool, options(folder)),
    ).resolves.toMatchObject({ applied: ["0001_migration"], adopted: [] });
    expect(
      client.statements.some((s) => s.includes("pg_catalog.pg_attribute")),
    ).toBe(false);
  });

  test("an empty journal table still adopts the baseline", async () => {
    const folder = baselineThenMigration();
    const { pool } = fakePool({ recorded: [], catalog: BASELINE_CATALOG });

    await expect(
      applyPendingMigrations(pool, options(folder)),
    ).resolves.toMatchObject({
      applied: ["0001_migration"],
      adopted: ["0000_baseline"],
    });
  });

  test("a migration failing after the adoption says the baseline stays recorded", async () => {
    const folder = baselineThenMigration();
    const { pool, state } = fakePool({
      recorded: null,
      catalog: BASELINE_CATALOG,
      failOn: /ADD COLUMN "title"/,
    });

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect(error).toMatchObject({
      pending: ["0001_migration"],
      adopted: ["0000_baseline"],
    });
    expect((error as Error).message).toBe(
      "Migration 0001_migration failed (SQLSTATE 42P07) and was rolled back. 0000_baseline stays recorded as applied: its tables already existed. Not applied: 0001_migration.",
    );
    expect(state.recorded).toHaveLength(1);
  });

  test("a missing baseline snapshot names the file", async () => {
    const folder = baselineThenMigration();
    fs.rmSync(path.join(folder, "meta/0000_snapshot.json"));
    const { pool, client } = fakePool({ recorded: null });

    const error = await applyPendingMigrations(pool, options(folder)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationFilesError);
    expect((error as Error).message).toMatch(
      /^Missing .*meta\/0000_snapshot\.json for 0000_baseline\. Restore it from version control/,
    );
    expect(client.released).toEqual({ error: undefined });
  });
});
