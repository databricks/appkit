import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  applyPendingMigrations,
  MigrationApplyError,
  MigrationBaselineMismatchError,
  migrationLockKey,
} from "../apply";
import { type Journal, MigrationFilesError } from "../paths";

const folders: string[] = [];

/** Write a v7 journal with one SQL file per entry, the way drizzle-kit lays them out. */
function migrations(
  entries: Array<{
    tag: string;
    when: number;
    sql: string[];
    /** Tables (name → columns) for meta/NNNN_snapshot.json. */
    snapshot?: Record<string, string[]>;
  }>,
) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-apply-"));
  folders.push(folder);
  fs.mkdirSync(path.join(folder, "meta"));
  const journal: Journal = {
    version: "7",
    dialect: "postgresql",
    entries: entries.map((entry, idx) => ({
      idx,
      version: "7",
      when: entry.when,
      tag: entry.tag,
      breakpoints: true,
    })),
  };
  fs.writeFileSync(
    path.join(folder, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  entries.forEach((entry, idx) => {
    fs.writeFileSync(
      path.join(folder, `${entry.tag}.sql`),
      entry.sql.join("--> statement-breakpoint\n"),
    );
    if (entry.snapshot) {
      const tables = Object.fromEntries(
        Object.entries(entry.snapshot).map(([name, columns]) => [
          `app.${name}`,
          {
            name,
            schema: "app",
            columns: Object.fromEntries(columns.map((c) => [c, { name: c }])),
          },
        ]),
      );
      fs.writeFileSync(
        path.join(
          folder,
          "meta",
          `${String(idx).padStart(4, "0")}_snapshot.json`,
        ),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          tables,
          enums: {},
        }),
      );
    }
  });
  return folder;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

interface FakeState {
  journalTableExists: boolean;
  lastCreatedAt: number | null;
  failOn?: RegExp;
  /** SQLSTATE of the failOn error; defaults to 42P07 (duplicate_table). */
  failCode?: string;
  failCleanupOn?: RegExp;
  /** pg_catalog (table, column) pairs the baseline check sees. */
  catalog?: Array<[string, string]>;
  /** Another instance holds the migration lock, so the first try fails. */
  lockHeld?: boolean;
}

/**
 * A pg PoolClient that records every statement. Its class name must not contain
 * "Pool": drizzle-orm would take it for a pool and call connect() on it.
 */
class RecordingClient {
  readonly statements: string[] = [];
  /** Parameters of each journal insert. */
  readonly recorded: unknown[][] = [];
  released: { error: unknown } | undefined;

  constructor(private readonly state: FakeState) {}

  async query(
    input: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ) {
    const text = (typeof input === "string" ? input : input.text).trim();
    const params = values ?? (typeof input === "string" ? [] : input.values);
    this.statements.push(text);
    if (this.state.failOn?.test(text)) {
      throw Object.assign(new Error("relation already exists"), {
        code: this.state.failCode ?? "42P07",
      });
    }
    if (this.state.failCleanupOn?.test(text)) {
      throw new Error("connection lost");
    }
    if (text.includes("pg_try_advisory_lock(")) {
      return { rows: [{ locked: !this.state.lockHeld }] };
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
      return { rows: this.state.journalTableExists ? [{ one: 1 }] : [] };
    }
    if (text.startsWith(`insert into "app"."__drizzle_migrations"`)) {
      this.recorded.push(params ?? []);
      this.state.journalTableExists = true;
      this.state.lastCreatedAt = Number(params?.[1]);
    }
    if (text.startsWith("select max(created_at)")) {
      return { rows: [{ last: this.state.lastCreatedAt }] };
    }
    if (text.includes("order by created_at desc limit 1")) {
      return {
        rows:
          this.state.lastCreatedAt === null
            ? []
            : [{ id: 1, hash: "h", created_at: this.state.lastCreatedAt }],
      };
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

/** Collapse the recorded statements into readable steps. */
function steps(statements: readonly string[]): string[] {
  return statements.map((statement) => {
    if (statement.includes("pg_try_advisory_lock(")) return "try lock";
    if (statement.includes("pg_advisory_lock(")) return "lock";
    if (statement.includes("pg_advisory_unlock(")) return "unlock";
    if (statement.includes("pg_catalog.pg_attribute"))
      return "baseline tables?";
    if (statement.includes("pg_catalog.pg_class")) return "journal table?";
    if (statement.startsWith("select max(created_at)")) return "last applied?";
    return statement.replace(/\s+/g, " ");
  });
}

describe("applyPendingMigrations", () => {
  test("applies every pending migration as the connecting identity under the advisory lock, then unlocks and releases", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
    });

    const result = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    });

    expect(result.applied).toEqual(["0000_migration", "0001_migration"]);
    expect(steps(client.statements)).toEqual([
      "SET statement_timeout = 0",
      "try lock",
      "SET lock_timeout = '30s'",
      "journal table?",
      // drizzle-orm's migrator as the connecting identity (no SET ROLE), journal in the app schema:
      `CREATE SCHEMA IF NOT EXISTS "app"`,
      `CREATE TABLE IF NOT EXISTS "app"."__drizzle_migrations" ( id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint )`,
      `select id, hash, created_at from "app"."__drizzle_migrations" order by created_at desc limit 1`,
      "begin",
      `CREATE TABLE "app"."notes" ("id" integer);`,
      `insert into "app"."__drizzle_migrations" ("hash", "created_at") values($1, $2)`,
      `ALTER TABLE "app"."notes" ADD COLUMN "body" text;`,
      `ALTER TABLE "app"."notes" ADD COLUMN "title" text;`,
      `insert into "app"."__drizzle_migrations" ("hash", "created_at") values($1, $2)`,
      "commit",
      "unlock",
      "RESET lock_timeout",
      "RESET statement_timeout",
    ]);
    expect(client.released).toEqual({ error: undefined });
  });

  test("applies only entries newer than the last recorded migration", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      journalTableExists: true,
      lastCreatedAt: 1000,
    });

    const result = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    });

    expect(result.applied).toEqual(["0001_migration"]);
    expect(client.statements).not.toContain(
      `CREATE TABLE "app"."notes" ("id" integer);`,
    );
    expect(client.statements).toContain(
      `ALTER TABLE "app"."notes" ADD COLUMN "body" text;`,
    );
  });

  test("with nothing pending, issues no migration SQL", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      journalTableExists: true,
      lastCreatedAt: 2000,
    });

    const result = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    });

    expect(result.applied).toEqual([]);
    expect(steps(client.statements)).toEqual([
      "SET statement_timeout = 0",
      "try lock",
      "SET lock_timeout = '30s'",
      "journal table?",
      "last applied?",
      "unlock",
      "RESET lock_timeout",
      "RESET statement_timeout",
    ]);
    expect(client.released).toEqual({ error: undefined });
  });

  test("without a journal it never connects", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-apply-"));
    folders.push(folder);
    const fake = fakePool({ journalTableExists: false, lastCreatedAt: null });

    await expect(
      applyPendingMigrations(fake.pool, {
        migrationsFolder: folder,
        schemaName: "app",
      }),
    ).resolves.toEqual({ applied: [], adopted: [] });
    expect(fake.connects()).toBe(0);
  });

  test("a failing statement rolls back all pending migrations and still unlocks and releases", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      failOn: /ADD COLUMN "title"/,
    });

    const error = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect(error).toMatchObject({
      pending: ["0000_migration", "0001_migration"],
      code: "42P07",
    });
    expect((error as Error).message).toBe(
      "Applying migrations 0000_migration, 0001_migration failed (SQLSTATE 42P07); none were applied.",
    );
    expect(steps(client.statements).slice(-5)).toEqual([
      `ALTER TABLE "app"."notes" ADD COLUMN "title" text;`,
      "rollback",
      "unlock",
      "RESET lock_timeout",
      "RESET statement_timeout",
    ]);
    expect(client.released).toEqual({ error: undefined });
  });

  test("an ownership failure (42501) names the branch-owner rule and the fix", async () => {
    const folder = twoMigrations();
    const { pool } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      failOn: /ADD COLUMN "body"/,
      failCode: "42501",
    });

    const error = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "42501" });
    expect((error as Error).message).toMatch(
      /^Applying migrations 0000_migration, 0001_migration failed \(SQLSTATE 42501\); none were applied\. The connecting role lacks a privilege this migration needs: /,
    );
  });

  test("a failed unlock destroys the connection instead of returning it to the pool", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      failCleanupOn: /pg_advisory_unlock/,
    });

    await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    });

    // The remaining cleanup still runs.
    expect(steps(client.statements).slice(-3)).toEqual([
      "unlock",
      "RESET lock_timeout",
      "RESET statement_timeout",
    ]);
    expect(client.released?.error).toBeInstanceOf(Error);
  });

  test("a failure before the lock is held releases without unlocking", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      failOn: /pg_try_advisory_lock/,
    });

    await expect(
      applyPendingMigrations(pool, {
        migrationsFolder: folder,
        schemaName: "app",
      }),
    ).rejects.toThrow("relation already exists");
    expect(steps(client.statements)).toEqual([
      "SET statement_timeout = 0",
      "try lock",
      "RESET lock_timeout",
      "RESET statement_timeout",
    ]);
    expect(client.released).toEqual({ error: undefined });
  });
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

describe("applyPendingMigrations — baseline adoption", () => {
  test("none of the baseline's tables exist: the baseline runs like any migration", async () => {
    const folder = baselineThenMigration();
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      catalog: [],
    });

    const result = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    });

    expect(result).toEqual({
      applied: ["0000_baseline", "0001_migration"],
      adopted: [],
    });
    expect(client.statements).toContain(BASELINE_SQL[0]);
  });

  test("every baseline table and column exists: the baseline is recorded, not run, and later migrations apply", async () => {
    const folder = baselineThenMigration();
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      catalog: [
        ["notes", "id"],
        ["notes", "body"],
        ["tags", "id"],
      ],
    });

    const result = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    });

    expect(result).toEqual({
      applied: ["0001_migration"],
      adopted: ["0000_baseline"],
    });
    expect(client.statements).not.toContain(BASELINE_SQL[0]);
    expect(client.statements).toContain(
      `ALTER TABLE "app"."notes" ADD COLUMN "title" text;`,
    );
    // The adopted row carries exactly what drizzle-orm's migrator would have written.
    const baselineFile = fs.readFileSync(
      path.join(folder, "0000_baseline.sql"),
      "utf-8",
    );
    expect(client.recorded[0]).toEqual([
      createHash("sha256").update(baselineFile).digest("hex"),
      1000,
    ]);
    expect(steps(client.statements).slice(0, 10)).toEqual([
      "SET statement_timeout = 0",
      "try lock",
      "SET lock_timeout = '30s'",
      "journal table?",
      "baseline tables?",
      "begin",
      `CREATE SCHEMA IF NOT EXISTS "app"`,
      `CREATE TABLE IF NOT EXISTS "app"."__drizzle_migrations" ( id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint )`,
      `insert into "app"."__drizzle_migrations" ("hash", "created_at") values($1, $2)`,
      "commit",
    ]);
    expect(client.released).toEqual({ error: undefined });
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
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      catalog: [
        ["notes", "id"],
        ["notes", "body"],
        ["tags", "id"],
      ],
    });

    await expect(
      applyPendingMigrations(pool, {
        migrationsFolder: folder,
        schemaName: "app",
      }),
    ).resolves.toEqual({ applied: [], adopted: ["0000_baseline"] });
    expect(client.statements.slice(-3)).toEqual([
      expect.stringContaining("pg_advisory_unlock"),
      "RESET lock_timeout",
      "RESET statement_timeout",
    ]);
  });

  test("only part of the baseline exists: MigrationBaselineMismatchError, nothing recorded or run", async () => {
    const folder = baselineThenMigration();
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      catalog: [["notes", "id"]],
    });

    const error = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationBaselineMismatchError);
    expect((error as MigrationBaselineMismatchError).problems).toEqual([
      "table app.notes is missing column body",
      "table app.tags does not exist",
    ]);
    expect((error as Error).message).toMatch(
      /^Cannot adopt 0000_baseline: schema "app" has no recorded migrations and only part of the baseline: /,
    );
    expect(client.recorded).toEqual([]);
    expect(client.statements).not.toContain("begin");
    expect(steps(client.statements).slice(-3)).toEqual([
      "unlock",
      "RESET lock_timeout",
      "RESET statement_timeout",
    ]);
    expect(client.released).toEqual({ error: undefined });
  });

  test("recording the adopted baseline fails: MigrationApplyError with the SQLSTATE and the ownership hint", async () => {
    const folder = baselineThenMigration();
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      catalog: [
        ["notes", "id"],
        ["notes", "body"],
        ["tags", "id"],
      ],
      // The schema belongs to another role, so the journal table cannot be created in it.
      failOn: /^CREATE TABLE IF NOT EXISTS "app"\."__drizzle_migrations"/,
      failCode: "42501",
    });

    const error = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect(error).toMatchObject({ pending: ["0000_baseline"], code: "42501" });
    expect((error as Error).message).toContain(
      "On the deploy branch that role is the app's service principal",
    );
    expect(client.statements).toContain("rollback");
    expect(client.statements).not.toContain(
      `ALTER TABLE "app"."notes" ADD COLUMN "title" text;`,
    );
  });

  test("with a recorded migration, the baseline is never adopted", async () => {
    const folder = baselineThenMigration();
    const { pool, client } = fakePool({
      journalTableExists: true,
      lastCreatedAt: 1000,
      catalog: [["notes", "id"]],
    });

    await expect(
      applyPendingMigrations(pool, {
        migrationsFolder: folder,
        schemaName: "app",
      }),
    ).resolves.toEqual({ applied: ["0001_migration"], adopted: [] });
    expect(
      client.statements.some((s) => s.includes("pg_catalog.pg_attribute")),
    ).toBe(false);
  });

  test("an empty journal table, left by a failed first deploy, still adopts the baseline", async () => {
    const folder = baselineThenMigration();
    const { pool } = fakePool({
      journalTableExists: true,
      lastCreatedAt: null,
      catalog: [
        ["notes", "id"],
        ["notes", "body"],
        ["tags", "id"],
      ],
    });

    await expect(
      applyPendingMigrations(pool, {
        migrationsFolder: folder,
        schemaName: "app",
      }),
    ).resolves.toEqual({
      applied: ["0001_migration"],
      adopted: ["0000_baseline"],
    });
  });

  test("a migration failing after the adoption says the baseline stays recorded", async () => {
    const folder = baselineThenMigration();
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
      catalog: [
        ["notes", "id"],
        ["notes", "body"],
        ["tags", "id"],
      ],
      failOn: /ADD COLUMN "title"/,
    });

    const error = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect(error).toMatchObject({
      pending: ["0001_migration"],
      adopted: ["0000_baseline"],
    });
    expect((error as Error).message).toBe(
      "Applying migration 0001_migration failed (SQLSTATE 42P07); none were applied. 0000_baseline stays recorded as applied: its tables already existed.",
    );
    expect(client.recorded).toHaveLength(1);
  });

  test("a missing baseline snapshot names the file", async () => {
    const folder = baselineThenMigration();
    fs.rmSync(path.join(folder, "meta/0000_snapshot.json"));
    const { pool, client } = fakePool({
      journalTableExists: false,
      lastCreatedAt: null,
    });

    const error = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationFilesError);
    expect((error as Error).message).toMatch(
      /^Missing .*meta\/0000_snapshot\.json for 0000_baseline\. Restore it from version control/,
    );
    expect(client.released).toEqual({ error: undefined });
  });
});

describe("applyPendingMigrations — failures name their cause", () => {
  test("reading the recorded migrations fails (42501): the hint, and nothing applied", async () => {
    const folder = twoMigrations();
    const { pool, client } = fakePool({
      journalTableExists: true,
      lastCreatedAt: 1000,
      // The journal table belongs to another role.
      failOn: /^select max\(created_at\)/,
      failCode: "42501",
    });

    const error = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationApplyError);
    expect(error).toMatchObject({ pending: [], code: "42501" });
    expect((error as Error).message).toMatch(
      /^Reading the recorded migrations in __drizzle_migrations failed \(SQLSTATE 42501\); none were applied\. The connecting role lacks a privilege/,
    );
    expect(steps(client.statements).slice(-3)).toEqual([
      "unlock",
      "RESET lock_timeout",
      "RESET statement_timeout",
    ]);
  });

  test("a table lock held past the lock timeout says to deploy again", async () => {
    const folder = twoMigrations();
    const { pool } = fakePool({
      journalTableExists: true,
      lastCreatedAt: 1000,
      failOn: /ADD COLUMN "body"/,
      failCode: "55P03",
    });

    const error = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      "Applying migration 0001_migration failed (SQLSTATE 55P03); none were applied. Another session held a lock on a table this migration changes for over 30s; deploy again once it finishes.",
    );
  });

  test("a Node system error is not reported as a SQLSTATE", async () => {
    const folder = twoMigrations();
    const { pool } = fakePool({
      journalTableExists: true,
      lastCreatedAt: 1000,
      failOn: /ADD COLUMN "body"/,
      failCode: "EPIPE",
    });

    const error = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: undefined });
    expect((error as Error).message).toBe(
      "Applying migration 0001_migration failed; none were applied.",
    );
  });

  test("a missing .sql file fails before connecting, naming the file", async () => {
    const folder = twoMigrations();
    fs.rmSync(path.join(folder, "0001_migration.sql"));
    const fake = fakePool({ journalTableExists: false, lastCreatedAt: null });

    const error = await applyPendingMigrations(fake.pool, {
      migrationsFolder: folder,
      schemaName: "app",
    }).catch((caught: unknown) => caught);

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
      const fake = fakePool({ journalTableExists: false, lastCreatedAt: null });

      const error = await applyPendingMigrations(fake.pool, {
        migrationsFolder: folder,
        schemaName: "app",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MigrationFilesError);
      expect((error as Error).message).toMatch(message);
      expect(fake.connects()).toBe(0);
    },
  );

  test("waits for another instance's lock, and says so", async () => {
    const folder = twoMigrations();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { pool, client } = fakePool({
      journalTableExists: true,
      lastCreatedAt: 2000,
      lockHeld: true,
    });

    await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: "app",
    });

    expect(steps(client.statements).slice(0, 4)).toEqual([
      "SET statement_timeout = 0",
      "try lock",
      "lock",
      "SET lock_timeout = '30s'",
    ]);
    expect(log.mock.calls.flat().map(String).join(" ")).toContain(
      "Waiting for another instance to finish migrating schema app",
    );
  });
});
