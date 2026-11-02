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
import { migrateOnStart, shouldMigrateOnStart } from "../migrate-on-start";

// The default schema, app, holds the journal too.
const schema = defineSchema(({ table }) => ({
  notes: table("notes", { id: id() }),
}));
const roots: string[] = [];
const pool = { connect: vi.fn() };
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
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("shouldMigrateOnStart", () => {
  const credentials = {
    DATABRICKS_CLIENT_ID: "sp-client-id",
    DATABRICKS_CLIENT_SECRET: "secret",
  };
  const optIn = { APPKIT_DB_MIGRATE_ON_START: "true" };

  test.each([
    ["a deployed app that opts in", { ...optIn, ...credentials }, true],
    [
      "a deployed app without the flag",
      { DATABRICKS_APP_NAME: "my-app", ...credentials },
      false,
    ],
    [
      "a flag other than true",
      { APPKIT_DB_MIGRATE_ON_START: "1", ...credentials },
      false,
    ],
    [
      "`databricks apps run-local`: the flag from app.yaml, no credentials",
      { ...optIn, DATABRICKS_APP_NAME: "my-app" },
      false,
    ],
    [
      "no client secret (a developer's own credentials)",
      { ...optIn, DATABRICKS_CLIENT_ID: "x" },
      false,
    ],
    ["no client id", { ...optIn, DATABRICKS_CLIENT_SECRET: "x" }, false],
    ["nothing set", {}, false],
  ] as const)("%s → %s", (_label, env, expected) => {
    expect(shouldMigrateOnStart(env)).toBe(expected);
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
    });
    const logged = log.mock.calls.map((call) => call.map(String).join(" "));
    expect(logged).toEqual([
      expect.stringMatching(
        /Migrations for schema app from .*: applied=1 adopted=1 edited=0 unknown=0 lock_wait_ms=12 duration_ms=\d+/,
      ),
    ]);
  });

  test.each([
    ["a developer branch", "dev-jane-a1b2c3"],
    ["an agent session branch", "session-k3x9q2m7"],
  ])(
    "%s is never migrated on start, even with committed migrations",
    async (_label, branch) => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      await migrateOnStart(pool, schema, appRootWithMigrations(), {
        ...deployEnv,
        LAKEBASE_ENDPOINT: `projects/p/branches/${branch}/endpoints/primary`,
      });

      expect(applyPendingMigrations).not.toHaveBeenCalled();
      expect(warn.mock.calls.flat().map(String).join(" ")).toContain(
        `Not migrating branch ${branch} on start`,
      );
    },
  );

  test.each([
    ["a branch that only starts with dev-", "dev-environment"],
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
      new apply.MigrationHistoryError("app", ["0001_parallel"], "0002_b"),
      "Migration 0001_parallel is older than 0002_b",
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
