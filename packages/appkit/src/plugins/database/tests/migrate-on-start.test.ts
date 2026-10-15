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

const schema = defineSchema(
  ({ table }) => ({ notes: table("notes", { id: id() }) }),
  { schemaName: "app" },
);
const roots: string[] = [];
const pool = { connect: vi.fn() };

function appRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-migrate-start-"));
  roots.push(root);
  return root;
}

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
  const app = { DATABRICKS_APP_NAME: "my-app", ...credentials };

  test.each([
    ["a deployed app", { ...app, NODE_ENV: "production" }, true],
    ["a deployed app without NODE_ENV", app, true],
    [
      "local development, even with app credentials",
      { ...app, NODE_ENV: "development" },
      false,
    ],
    [
      "`databricks apps run-local`: the app name without its credentials",
      { DATABRICKS_APP_NAME: "my-app", NODE_ENV: "production" },
      false,
    ],
    [
      "a local production start with app credentials in .env but no app name",
      { ...credentials, NODE_ENV: "production" },
      false,
    ],
    [
      "no client secret (a developer's own credentials)",
      {
        DATABRICKS_APP_NAME: "my-app",
        DATABRICKS_CLIENT_ID: "x",
        NODE_ENV: "production",
      },
      false,
    ],
    [
      "no client id",
      {
        DATABRICKS_APP_NAME: "my-app",
        DATABRICKS_CLIENT_SECRET: "x",
        NODE_ENV: "production",
      },
      false,
    ],
    ["nothing set", {}, false],
  ] as const)("%s → %s", (_label, env, expected) => {
    expect(shouldMigrateOnStart(env)).toBe(expected);
  });
});

describe("migrateOnStart", () => {
  test("no committed journal: a no-op that never connects", async () => {
    await migrateOnStart(pool, schema, appRoot());

    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("applies from <root>/config/database/migrations into the schema's own journal, and logs what it did", async () => {
    const root = appRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    applyPendingMigrations.mockResolvedValueOnce({
      applied: ["0001_migration"],
      adopted: ["0000_baseline"],
    });

    await migrateOnStart(pool, schema, root);

    expect(applyPendingMigrations).toHaveBeenCalledWith(pool, {
      migrationsFolder: path.join(root, "config/database/migrations"),
      schemaName: "app",
    });
    const logged = log.mock.calls.map((call) => call.map(String).join(" "));
    expect(logged).toEqual([
      expect.stringContaining(
        "Adopted 0000_baseline in schema app: its tables already existed",
      ),
      expect.stringContaining(
        "Applied migrations 0001_migration to schema app",
      ),
    ]);
  });

  test("nothing pending logs nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    applyPendingMigrations.mockResolvedValueOnce({ applied: [], adopted: [] });

    await migrateOnStart(pool, schema, appRoot());

    expect(log).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a failed migration",
      new apply.MigrationApplyError(["0001_migration"], "42501"),
      "Applying migration 0001_migration failed (SQLSTATE 42501); none were applied.",
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

      const error = await migrateOnStart(pool, schema, appRoot()).catch(
        (caught: unknown) => caught,
      );

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

    await expect(migrateOnStart(pool, schema, appRoot())).rejects.toBe(raw);
  });
});
