import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

const { createDbContext, runVerify } = vi.hoisted(() => ({
  createDbContext: vi.fn(() => ({ root: "/app", env: {} })),
  runVerify: vi.fn(),
}));

// The tooling is an ambient module loaded with a dynamic import; mock it so the
// command never touches a database.
vi.mock("@databricks/appkit/database-tooling", () => ({
  createDbContext,
  runVerify,
}));

import { dbCommand } from "./index";

let log: MockInstance;
let error: MockInstance;

function output(spy: MockInstance): string {
  return spy.mock.calls.map((call) => call.join(" ")).join("\n");
}

const local = {
  kind: "local" as const,
  branch: "projects/p/branches/dev-alice-3f9a2c",
  schemaProblems: [],
  pendingMigrations: [],
  strandedMigrations: [],
  ok: true,
};

beforeEach(() => {
  runVerify.mockReset();
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("appkit db verify", () => {
  test("is registered under the db group", () => {
    expect(dbCommand.commands.map((command) => command.name())).toContain(
      "verify",
    );
  });

  test("a clean branch prints one line and exits 0", async () => {
    runVerify.mockResolvedValue({
      ...local,
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(log)).toContain(
      "dev-alice-3f9a2c matches config/database/schema.ts and has every committed migration",
    );
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("prints every schema problem and pending migration, and exits 1", async () => {
    runVerify.mockResolvedValue({
      ...local,
      schemaProblems: [
        "table app.notes is missing column body",
        "table app.tags does not exist",
      ],
      pendingMigrations: ["0001_migration", "0002_migration"],
      ok: false,
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    const printed = output(log);
    expect(printed).toContain("Schema: table app.notes is missing column body");
    expect(printed).toContain("Schema: table app.tags does not exist");
    expect(printed).toContain(
      "Pending migrations: 0001_migration, 0002_migration",
    );
    expect(output(error)).toContain(
      "dev-alice-3f9a2c does not match config/database/schema.ts and the committed migrations. Run `appkit db migrate` to apply the pending migrations.",
    );
    expect(process.exitCode).toBe(1);
  });

  test("schema problems without pending migrations point to migrate or clean", async () => {
    runVerify.mockResolvedValue({
      ...local,
      schemaProblems: ["table app.notes is missing column body"],
      ok: false,
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(error)).toContain(
      "If you changed schema.ts, run `appkit db migrate`; if the branch was changed by hand, `appkit db clean` and then `appkit db migrate` rebuild it from the migrations.",
    );
    expect(process.exitCode).toBe(1);
  });

  test("only pending migrations still exit 1", async () => {
    runVerify.mockResolvedValue({
      ...local,
      pendingMigrations: ["0001_migration"],
      ok: false,
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(log)).not.toContain("Schema:");
    expect(process.exitCode).toBe(1);
  });

  test("names each migration that never runs and why, and how to rebuild the branch", async () => {
    runVerify.mockResolvedValue({
      ...local,
      strandedMigrations: [
        { tag: "0001_parallel", reason: "out of order" },
        { tag: "0000_migration", reason: "edited" },
      ],
      ok: false,
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    const printed = output(log);
    expect(printed).toContain(
      "Never runs: 0001_parallel: it is older than a migration the branch already ran (merged out of order); the deployed app skips it too once it ran a newer one",
    );
    expect(printed).toContain(
      "Never runs: 0000_migration: it changed after the branch ran it; restore it from version control and put the change in a new migration",
    );
    expect(output(error)).toContain(
      "`appkit db clean` and then `appkit db migrate` rebuild the branch from the migrations, in order.",
    );
    expect(process.exitCode).toBe(1);
  });

  test("without --prod it checks the .env branch", async () => {
    runVerify.mockResolvedValue({
      ...local,
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(runVerify).toHaveBeenCalledWith(expect.anything(), { prod: false });
  });

  describe("--prod", () => {
    const deploy = {
      kind: "deploy" as const,
      branch: "projects/p/branches/production",
      app: "my-app",
      problems: [],
      ok: true,
    };

    test("a running app on the deploy branch prints one line and exits 0", async () => {
      runVerify.mockResolvedValue(deploy);

      await dbCommand.parseAsync(["verify", "--prod"], { from: "user" });

      expect(runVerify).toHaveBeenCalledWith(expect.anything(), { prod: true });
      expect(output(log)).toContain(
        "app my-app is running on production (deploy branch): on start it applied its migrations and checked its schema",
      );
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    test("lists each problem with its fix, and exits 1", async () => {
      runVerify.mockResolvedValue({
        ...deploy,
        problems: [
          "app my-app has no postgres resource: `databricks apps deploy` adds the one databricks.yml declares",
          "app my-app is crashed: App crashed unexpectedly. `databricks apps logs` shows why; a migration that fails stops the app on start",
        ],
        ok: false,
      });

      await dbCommand.parseAsync(["verify", "--prod"], { from: "user" });

      const printed = output(log);
      expect(printed).toContain(
        "app my-app has no postgres resource: `databricks apps deploy` adds the one databricks.yml declares",
      );
      expect(printed).toContain(
        "app my-app is crashed: App crashed unexpectedly.",
      );
      expect(output(error)).toContain(
        "app my-app cannot use production (deploy branch) yet. Fix the above, then run `appkit db verify --prod` again.",
      );
      expect(process.exitCode).toBe(1);
    });

    test("without an app in databricks.yml it names the deployed app generically", async () => {
      runVerify.mockResolvedValue({
        ...deploy,
        app: null,
        problems: ["databricks.yml declares no app"],
        ok: false,
      });

      await dbCommand.parseAsync(["verify", "--prod"], { from: "user" });

      expect(output(error)).toContain(
        "The deployed app cannot use production (deploy branch) yet.",
      );
    });
  });

  test("an error is printed and exits 1", async () => {
    runVerify.mockRejectedValue(
      new Error(
        "No branch configured (PGHOST, PGDATABASE, LAKEBASE_ENDPOINT) — run `appkit db init`.",
      ),
    );

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(error)).toContain("No branch configured");
    expect(process.exitCode).toBe(1);
  });
});
