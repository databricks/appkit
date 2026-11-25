import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { applyPendingMigrations } = vi.hoisted(() => ({
  applyPendingMigrations: vi.fn(),
}));
vi.mock("../../../database/migrations/apply", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../database/migrations/apply")
  >()),
  applyPendingMigrations,
}));

import { DatabasePluginError } from "../../../database/errors";
import * as apply from "../../../database/migrations/apply";
import { MigrationFilesError } from "../../../database/migrations/paths";
import { defineSchema, id } from "../../../database/schema-builder";
import { decideMigrateOnStart, migrateOnStart } from "../migrate-on-start";

// The default schema, app, holds the journal too.
const schema = defineSchema(({ table }) => ({
  notes: table("notes", { id: id() }),
}));
const roots: string[] = [];
const pool = { connect: vi.fn(), query: vi.fn() };
const deployEnv = {
  LAKEBASE_ENDPOINT: "projects/p/branches/production/endpoints/primary",
  PGHOST: "ep-abc.database.cloud.databricks.com",
};

function appRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-migrate-start-"));
  roots.push(root);
  return root;
}

/** An app root with a committed (empty) journal. */
function appRootWithMigrations(): string {
  const root = appRoot();
  const meta = path.join(root, "config/database/migrations/meta");
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(
    path.join(meta, "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }),
  );
  return root;
}

const nothingDone = {
  applied: [],
  adopted: [],
  edited: [],
  unknown: 0,
  lockWaitMs: 0,
};

beforeEach(async () => {
  const actual = await vi.importActual<
    typeof import("../../../database/migrations/apply")
  >("../../../database/migrations/apply");
  applyPendingMigrations.mockReset();
  applyPendingMigrations.mockImplementation(actual.applyPendingMigrations);
  pool.connect.mockReset();
  pool.query.mockReset();
  // A fresh database: the catalog holds none of the declared tables anywhere.
  pool.query.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("decideMigrateOnStart", () => {
  const credentials = {
    DATABRICKS_CLIENT_ID: "sp-client-id",
    DATABRICKS_CLIENT_SECRET: "secret",
  };
  const optIn = { APPKIT_DB_MIGRATE_ON_START: "true" };

  test("a deployed app with a bound database migrates. Apps sets PGUSER to its client id", () => {
    expect(
      decideMigrateOnStart({
        ...optIn,
        ...credentials,
        PGUSER: "sp-client-id",
      }),
    ).toEqual({ kind: "migrate" });
  });

  test.each([
    [
      "a deployed app without the flag",
      { DATABRICKS_APP_NAME: "my-app", ...credentials },
    ],
    [
      "a flag other than true",
      { APPKIT_DB_MIGRATE_ON_START: "1", ...credentials },
    ],
    ["nothing set", {}],
  ] as const)("%s: off, with nothing to say", (_label, env) => {
    expect(decideMigrateOnStart(env)).toEqual({ kind: "off" });
  });

  test.each([
    [
      "`databricks apps run-local`: the flag from app.yaml, no credentials",
      { ...optIn, DATABRICKS_APP_NAME: "app" },
      "DATABRICKS_CLIENT_ID is not set.",
    ],
    [
      "no client secret (a developer's own credentials)",
      { ...optIn, DATABRICKS_CLIENT_ID: "x" },
      "DATABRICKS_CLIENT_SECRET is not set.",
    ],
    [
      "no client id",
      { ...optIn, DATABRICKS_CLIENT_SECRET: "x" },
      "DATABRICKS_CLIENT_ID is not set.",
    ],
    [
      "run-local with exported M2M credentials and the developer's .env",
      { ...optIn, ...credentials, PGUSER: "jane@example.com" },
      `PGUSER is "jane@example.com", not the app's client id in DATABRICKS_CLIENT_ID.`,
    ],
    [
      "exported M2M credentials and no PGUSER, where the pool would fall back to the service principal",
      { ...optIn, ...credentials },
      "PGUSER is not set. The deployed app gets it from its database resource.",
    ],
  ] as const)("%s: skipped, naming the reason", (_label, env, reason) => {
    expect(decideMigrateOnStart(env)).toEqual({ kind: "skipped", reason });
  });
});

describe("migrateOnStart", () => {
  test("no committed journal: says so and never connects", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = appRoot();

    await migrateOnStart(pool, schema, root, deployEnv);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().map(String).join(" ")).toContain(
      `No committed migrations at ${path.join(root, "config/database/migrations")}`,
    );
  });

  test("applies from <root>/config/database/migrations into the schema's own journal, and logs one summary", async () => {
    const root = appRootWithMigrations();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    applyPendingMigrations.mockResolvedValueOnce({
      ...nothingDone,
      applied: ["0001_migration"],
      adopted: ["0000_baseline"],
      lockWaitMs: 12,
    });

    await migrateOnStart(pool, schema, root, deployEnv);

    expect(applyPendingMigrations).toHaveBeenCalledWith(pool, {
      migrationsFolder: path.join(root, "config/database/migrations"),
      schemaName: "app",
      onDrift: "refuse",
    });
    const logged = log.mock.calls.map((call) => call.map(String).join(" "));
    expect(logged).toEqual([
      expect.stringMatching(
        /Migrations for schema app from .*: applied=1 adopted=1 edited=0 unknown=0 lock_wait_ms=12 duration_ms=\d+/,
      ),
    ]);
  });

  test.each([
    ["a developer branch", "dev-jane-a1b2c3", "a developer"],
    [
      "a developer branch with a dashed slug",
      "dev-jane-doe-2-a1b2c3",
      "a developer",
    ],
    ["an agent session branch", "session-a1b2c3-k3x9q2m7", "an agent session"],
  ])(
    "a deployed app bound to %s refuses to start, naming the branch and the fix",
    async (_label, branch, kind) => {
      const error = await migrateOnStart(
        pool,
        schema,
        appRootWithMigrations(),
        {
          ...deployEnv,
          LAKEBASE_ENDPOINT: `projects/p/branches/${branch}/endpoints/primary`,
        },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DatabasePluginError);
      expect(error).toMatchObject({ category: "SETUP_FAILED", phase: "setup" });
      expect((error as Error).message).toContain(
        `LAKEBASE_ENDPOINT points at branch "${branch}", whose name has the shape of ${kind} branch, and a deployed app migrates only its deploy branch. ` +
          "Bind the app to its deploy branch. If this is the deploy branch, rename it so it does not look like a dev or session branch.",
      );
      expect(applyPendingMigrations).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["a branch that only starts with dev-", "dev-environment"],
    ["a dev- branch without the six hex characters", "dev-jane-a1b2c"],
    [
      "a dev- shape longer than a branch id can be",
      `dev-${"a".repeat(54)}-a1b2c3`,
    ],
    ["a session- branch that is not an agent session", "session-store"],
    [
      "a session- branch whose id is not six hex characters",
      "session-k3x9q2m7",
    ],
    ["the production branch", "production"],
  ])("%s is migrated", async (_label, branch) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    applyPendingMigrations.mockResolvedValueOnce(nothingDone);

    await migrateOnStart(pool, schema, appRootWithMigrations(), {
      ...deployEnv,
      LAKEBASE_ENDPOINT: `projects/p/branches/${branch}/endpoints/primary`,
    });

    expect(applyPendingMigrations).toHaveBeenCalled();
  });

  test("a pooled endpoint is refused: the migration lock would not hold", async () => {
    const error = await migrateOnStart(pool, schema, appRootWithMigrations(), {
      ...deployEnv,
      PGHOST: "ep-abc-pooler.database.cloud.databricks.com",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabasePluginError);
    expect((error as Error).message).toContain(
      "is a pooled endpoint, and migrations need a direct connection",
    );
    expect(applyPendingMigrations).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a failed migration",
      new apply.MigrationApplyError({
        step: "Applying migrations",
        failed: "0001_migration",
        pending: ["0001_migration"],
        cause: Object.assign(new Error("denied"), { code: "42501" }),
      }),
      "Migration 0001_migration failed (SQLSTATE 42501) and was rolled back.",
    ],
    [
      "a stranded migration",
      new apply.MigrationHistoryError("app", {
        stranded: ["0001_parallel"],
        last: "0002_b",
      }),
      "Migration 0001_parallel is older than 0002_b",
    ],
    [
      "an edited migration",
      new apply.MigrationHistoryError("app", { edited: ["0001_migration"] }),
      'Migration 0001_migration changed after schema "app" applied it',
    ],
    [
      "a view at the journal's name",
      new apply.MigrationJournalError(
        "app",
        {
          relkind: "v",
          owner: "mallory",
          schemaOwner: "app-sp",
          currentUser: "app-sp",
          rowSecurity: false,
          trusted: false,
        },
        "kind",
      ),
      '"app"."__drizzle_migrations" is a view owned by "mallory"',
    ],
    [
      "a baseline that only partly matches",
      new apply.MigrationBaselineMismatchError("app", [
        "table app.tags does not exist",
      ]),
      "Cannot adopt 0000_baseline",
    ],
    [
      "a missing migration file",
      new MigrationFilesError(
        "Missing /app/config/database/migrations/0001_migration.sql, listed in meta/_journal.json. Restore it from version control.",
      ),
      "Missing /app/config/database/migrations/0001_migration.sql",
    ],
  ])(
    "%s becomes a setup failure that names it",
    async (_label, failure, reason) => {
      applyPendingMigrations.mockRejectedValueOnce(failure);

      const error = await migrateOnStart(
        pool,
        schema,
        appRootWithMigrations(),
        deployEnv,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DatabasePluginError);
      expect(error).toMatchObject({ category: "SETUP_FAILED", phase: "setup" });
      expect((error as Error).message).toContain(reason);
      // Only the stable message crosses a request boundary.
      expect((error as DatabasePluginError).clientMessage).toBe(
        "Database setup failed",
      );
    },
  );

  test("any other error is left to lifecycle's sanitizer", async () => {
    const raw = new Error("connection reset");
    applyPendingMigrations.mockRejectedValueOnce(raw);

    await expect(
      migrateOnStart(pool, schema, appRootWithMigrations(), deployEnv),
    ).rejects.toBe(raw);
  });
});

describe("migrateOnStart: tables an earlier release left in public", () => {
  const NOTES_SQL = 'CREATE TABLE "app"."notes" ("id" integer);';
  const NOTES_WHEN = 1000;
  // An upgraded app: public.notes holds its rows, app.notes does not exist.
  const notesInPublic = [{ schema_name: "public", table_name: "notes" }];

  /** An app root whose one committed migration, 0000_notes, creates app.notes. */
  function appRootWithNotesMigration(): { root: string; hash: string } {
    const root = appRoot();
    const folder = path.join(root, "config/database/migrations");
    fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: NOTES_WHEN,
            tag: "0000_notes",
            breakpoints: true,
          },
        ],
      }),
    );
    fs.writeFileSync(path.join(folder, "0000_notes.sql"), NOTES_SQL);
    return {
      root,
      hash: createHash("sha256").update(NOTES_SQL).digest("hex"),
    };
  }

  /**
   * The deploy branch's one connection. Its journal records `recorded`, and
   * the catalog lookup of the declared tables in app and public finds `catalog`.
   */
  function deployBranch(
    recorded: readonly string[],
    catalog: readonly { schema_name: string; table_name: string }[],
  ) {
    const statements: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (input: string) => {
        const text = input.trim();
        statements.push(text);
        if (text.includes("c.relowner")) {
          const journal = {
            relkind: "r",
            owner: "app-sp",
            schema_owner: "app-sp",
            current_user: "app-sp",
            row_security: false,
            trusted: true,
          };
          return { rows: recorded.length > 0 ? [journal] : [] };
        }
        if (text.startsWith("select hash, created_at")) {
          return {
            rows: recorded.map((hash) => ({ hash, created_at: NOTES_WHEN })),
          };
        }
        if (text.includes("pg_try_advisory_lock(")) {
          return { rows: [{ locked: true }] };
        }
        if (text.includes("'public'")) return { rows: catalog };
        return { rows: [] };
      }),
    };
    pool.connect.mockResolvedValue(client);
    return {
      statements,
      lookedInPublic: () =>
        statements.some((text) => text.includes("'public'")),
    };
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  test("a current branch costs one connection and one read of the journal: public is not looked at", async () => {
    const { root, hash } = appRootWithNotesMigration();
    const branch = deployBranch([hash], notesInPublic);

    await migrateOnStart(pool, schema, root, deployEnv);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(branch.lookedInPublic()).toBe(false);
    expect(branch.statements).toEqual([
      expect.stringContaining("c.relowner"),
      expect.stringMatching(/^select hash, created_at/),
    ]);
  });

  test("a pending migration, the default schema and every declared table in public: refused, nothing applied", async () => {
    const { root } = appRootWithNotesMigration();
    const branch = deployBranch([], notesInPublic);

    const error = await migrateOnStart(pool, schema, root, deployEnv).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DatabasePluginError);
    expect(error).toMatchObject({ category: "SETUP_FAILED", phase: "setup" });
    expect((error as Error).message).toContain(
      'not applying migrations: none of the declared tables exist in schema "app", but public has notes.',
    );
    expect((error as Error).message).toContain(
      'pass { schemaName: "public" } as the second argument of defineSchema()',
    );
    expect(branch.statements).not.toContain(NOTES_SQL);
    expect(branch.statements).not.toContain("begin");
  });

  test('schemaName "app" named explicitly is migrated, whatever public holds', async () => {
    const explicit = defineSchema(
      ({ table }) => ({ notes: table("notes", { id: id() }) }),
      { schemaName: "app" },
    );
    const { root } = appRootWithNotesMigration();
    const branch = deployBranch([], notesInPublic);

    await migrateOnStart(pool, explicit, root, deployEnv);

    expect(branch.statements).toContain(NOTES_SQL);
    expect(branch.lookedInPublic()).toBe(false);
  });

  test("a declared table already in app: migrated, whatever public holds", async () => {
    const { root } = appRootWithNotesMigration();
    const branch = deployBranch(
      [],
      [{ schema_name: "app", table_name: "notes" }, ...notesInPublic],
    );

    await migrateOnStart(pool, schema, root, deployEnv);

    expect(branch.statements).toContain(NOTES_SQL);
  });

  test("no committed journal: nothing to apply, so the catalog is not consulted", async () => {
    await migrateOnStart(pool, schema, appRoot(), deployEnv);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
