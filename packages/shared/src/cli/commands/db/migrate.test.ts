import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

const { createDbContext, runMigrate } = vi.hoisted(() => ({
  createDbContext: vi.fn(() => ({ root: "/app", env: {} })),
  runMigrate: vi.fn(),
}));

// The tooling is an ambient module loaded with a dynamic import; mock it so the
// command never touches drizzle-kit or a database.
vi.mock("@databricks/appkit/database-tooling", () => ({
  createDbContext,
  runMigrate,
}));

import { dbCommand } from "./index";

let log: MockInstance;
let error: MockInstance;

function output(spy: MockInstance): string {
  return spy.mock.calls.map((call) => call.join(" ")).join("\n");
}

beforeEach(() => {
  runMigrate.mockReset();
  createDbContext.mockClear();
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const typesFile = path.join(process.cwd(), "shared/appkit-types/database.d.ts");

describe("appkit db migrate", () => {
  test("is registered under the db group", () => {
    expect(dbCommand.commands.map((command) => command.name())).toContain(
      "migrate",
    );
  });

  test("prints the generated file, the applied tags and the types file", async () => {
    runMigrate.mockResolvedValue({
      generated: {
        tag: "0001_migration",
        file: path.join(
          process.cwd(),
          "config/database/migrations/0001_migration.sql",
        ),
        statements: ["a", "b"],
      },
      applied: ["0001_migration"],
      typesFile,
    });

    await dbCommand.parseAsync(["migrate"], { from: "user" });

    expect(createDbContext).toHaveBeenCalledWith();
    expect(runMigrate).toHaveBeenCalledWith(
      { root: "/app", env: {} },
      // Vitest workers have no TTY, so the run is non-interactive.
      { interactive: false },
    );
    const printed = output(log);
    expect(printed).toContain(
      `Generated ${path.join("config/database/migrations/0001_migration.sql")} (2 statements)`,
    );
    expect(printed).toContain("Applied 0001_migration to the .env branch");
    expect(printed).toContain(
      `Generated ${path.join("shared/appkit-types/database.d.ts")}`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  test("reports an unchanged schema and an up-to-date branch", async () => {
    runMigrate.mockResolvedValue({ generated: null, applied: [], typesFile });

    await dbCommand.parseAsync(["migrate"], { from: "user" });

    const printed = output(log);
    expect(printed).toContain("No schema changes since the last migration");
    expect(printed).toContain("The .env branch is up to date");
  });

  test("reports a baseline adopted without running it", async () => {
    runMigrate.mockResolvedValue({
      generated: null,
      applied: ["0001_migration"],
      adopted: ["0000_baseline"],
      typesFile,
    });

    await dbCommand.parseAsync(["migrate"], { from: "user" });

    const printed = output(log);
    expect(printed).toContain(
      "Adopted 0000_baseline: its tables already existed, so it was recorded without running",
    );
    expect(printed).toContain("Applied 0001_migration to the .env branch");
  });

  test("warns when the migration breaks instances of the previous release", async () => {
    const drop = 'ALTER TABLE "app"."notes" DROP COLUMN "body";';
    runMigrate.mockResolvedValue({
      generated: {
        tag: "0002_migration",
        file: path.join(
          process.cwd(),
          "config/database/migrations/0002_migration.sql",
        ),
        statements: [drop],
      },
      breaking: [drop],
      applied: ["0002_migration"],
      typesFile,
    });

    await dbCommand.parseAsync(["migrate"], { from: "user" });

    expect(output(log)).toContain(
      `0002_migration breaks instances still running the previous release, which keep serving while the new one migrates on start: ${drop} Deploy code that works with both the old and the new schema first, then this change in a later deploy.`,
    );
  });

  test("says why nothing was applied", async () => {
    runMigrate.mockResolvedValue({
      generated: null,
      applied: [],
      notApplied: "no branch configured — run appkit db init",
      typesFile,
    });

    await dbCommand.parseAsync(["migrate"], { from: "user" });

    expect(output(log)).toContain(
      "Not applied: no branch configured — run appkit db init",
    );
    expect(process.exitCode).toBeUndefined();
  });

  test("prints the error and its root cause, and exits 1", async () => {
    const driverError = new Error('relation "notes" already exists');
    const wrapped = new Error("Failed query: CREATE TABLE ...", {
      cause: driverError,
    });
    runMigrate.mockRejectedValue(
      new Error(
        "Applying migration 0000_migration failed (SQLSTATE 42P07); none were applied.",
        { cause: wrapped },
      ),
    );

    await dbCommand.parseAsync(["migrate"], { from: "user" });

    const printed = output(error);
    expect(printed).toContain(
      "Applying migration 0000_migration failed (SQLSTATE 42P07); none were applied.",
    );
    expect(printed).toContain('relation "notes" already exists');
    expect(process.exitCode).toBe(1);
  });
});
