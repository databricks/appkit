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
vi.mock("@databricks/appkit/beta/database-tooling", () => ({
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
  notYours: null,
  refusesEveryBranch: false,
  schemaProblems: [],
  pendingMigrations: [],
  strandedMigrations: [],
  editedMigrations: [],
  unknownMigrations: 0,
  ok: true,
};

/** Commander keeps parsed option values on the command; each test parses afresh. */
function resetOptionValues() {
  for (const command of dbCommand.commands) {
    for (const option of command.options) {
      command.setOptionValueWithSource(
        option.attributeName(),
        undefined,
        "default",
      );
    }
  }
}

beforeEach(() => {
  resetOptionValues();
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

  test("a clean branch prints what was checked and exits 0", async () => {
    runVerify.mockResolvedValue(local);

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(runVerify).toHaveBeenCalledWith(expect.anything(), {
      deployed: false,
    });
    expect(output(log)).toContain(
      "dev-alice-3f9a2c has every table and column config/database/schema.ts declares, and every committed migration",
    );
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("a .env branch that is not yours is named, with init as the way to your own", async () => {
    runVerify.mockResolvedValue({
      ...local,
      branch: "projects/p/branches/production",
      notYours: "it is the project's default branch",
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(log)).toContain(
      ".env points at production, not a branch `appkit db init` set up for you: it is the project's default branch. `npx appkit db init` points it at a branch of your own.",
    );
    expect(process.exitCode).toBeUndefined();
  });

  test("while databricks.yml leaves a reference unresolved, the warning says every branch refuses writes, not to run init", async () => {
    runVerify.mockResolvedValue({
      ...local,
      notYours:
        "databricks.yml may deploy to it: the files do not resolve variables.postgres_branch in target default (no value); give it a value in databricks.yml",
      refusesEveryBranch: true,
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(log)).toContain(
      "dev-alice-3f9a2c takes no writes (databricks.yml may deploy to it: the files do not resolve variables.postgres_branch in target default (no value); give it a value in databricks.yml). Until databricks.yml's references have values, `appkit db migrate`, `clean`, `seed` and `init` refuse every branch.",
    );
    expect(output(log)).not.toContain("npx appkit db init");
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

  test("a migration merged out of order is named, with how to rebuild the branch", async () => {
    runVerify.mockResolvedValue({
      ...local,
      strandedMigrations: ["0001_parallel"],
      ok: false,
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(log)).toContain(
      "Never runs: 0001_parallel: it is older than a migration the branch already ran (merged out of order); the deployed app skips it too once it ran a newer one",
    );
    expect(output(error)).toContain(
      "`appkit db clean` and then `appkit db migrate` rebuild the branch from this checkout's migrations, in order.",
    );
    expect(process.exitCode).toBe(1);
  });

  test("an edited migration is restored, not rebuilt over", async () => {
    runVerify.mockResolvedValue({
      ...local,
      strandedMigrations: ["0001_parallel"],
      editedMigrations: ["0000_migration"],
      ok: false,
    });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(log)).toContain(
      "Never runs: 0000_migration: it changed after the branch ran it, and a branch that ran it keeps the old version",
    );
    expect(output(error)).toContain(
      "Restore the edited migrations from version control, and put the change in a new migration.",
    );
  });

  test("migrations the branch ran that this checkout does not commit", async () => {
    runVerify.mockResolvedValue({ ...local, unknownMigrations: 2, ok: false });

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(log)).toContain(
      "Not committed: the branch ran 2 migrations this checkout does not have, for example from another git branch",
    );
    expect(output(error)).toContain(
      "rebuild the branch from this checkout's migrations, in order. If the branch ran migrations you have not pulled yet, pull them instead.",
    );
    expect(process.exitCode).toBe(1);
  });

  describe("--deployed", () => {
    const deploy = {
      kind: "deploy" as const,
      target: "prod",
      host: "https://acme.cloud.databricks.com",
      branch: "projects/p/branches/production",
      app: "my-app",
      migrations: { evidence: "verified" as const },
      problems: [],
      ok: true,
    };

    test("a ready app prints what was checked, target and host included, and exits 0", async () => {
      runVerify.mockResolvedValue(deploy);

      await dbCommand.parseAsync(["verify", "--deployed", "-t", "prod"], {
        from: "user",
      });

      expect(runVerify).toHaveBeenCalledWith(expect.anything(), {
        deployed: true,
        target: "prod",
      });
      const printed = output(log);
      expect(printed).toContain(
        "app my-app (target prod on https://acme.cloud.databricks.com) is running, bound to production with CAN_CONNECT_AND_CREATE, and its service principal has a role there",
      );
      expect(printed).toContain(
        "Its active deployment has every committed migration, with the same SQL",
      );
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    test("claims nothing about migrations when the checkout commits none", async () => {
      runVerify.mockResolvedValue({ ...deploy, migrations: null });

      await dbCommand.parseAsync(["verify", "--deployed"], { from: "user" });

      expect(runVerify).toHaveBeenCalledWith(expect.anything(), {
        deployed: true,
      });
      expect(output(log)).not.toContain("committed migration");
      expect(process.exitCode).toBeUndefined();
    });

    test("lists each problem with its fix, and exits 1", async () => {
      runVerify.mockResolvedValue({
        ...deploy,
        problems: [
          "app my-app has no postgres resource: `databricks apps deploy` adds the one databricks.yml declares",
          "app my-app's active deployment does not have 0003_migration, which this checkout commits: `databricks apps deploy` deploys it, and the app applies it on start",
        ],
        ok: false,
      });

      await dbCommand.parseAsync(["verify", "--deployed", "-t", "prod"], {
        from: "user",
      });

      const printed = output(log);
      expect(printed).toContain(
        "app my-app has no postgres resource: `databricks apps deploy` adds the one databricks.yml declares",
      );
      expect(printed).toContain(
        "app my-app's active deployment does not have 0003_migration",
      );
      expect(output(error)).toContain(
        "app my-app (target prod on https://acme.cloud.databricks.com) cannot use production yet. Fix the above, then run `appkit db verify --deployed -t prod` again.",
      );
      expect(process.exitCode).toBe(1);
    });

    test("without an app in the target it names the deployed app generically", async () => {
      runVerify.mockResolvedValue({
        ...deploy,
        host: null,
        app: null,
        migrations: null,
        problems: ["target prod in databricks.yml declares no app"],
        ok: false,
      });

      await dbCommand.parseAsync(["verify", "--deployed"], { from: "user" });

      expect(output(error)).toContain(
        "The deployed app (target prod) cannot use production yet.",
      );
    });
  });

  test("--target without --deployed is refused before loading the tooling", async () => {
    await dbCommand.parseAsync(["verify", "-t", "prod"], { from: "user" });

    expect(output(error)).toContain(
      "--target picks the databricks.yml target --deployed checks; pass --deployed with it.",
    );
    expect(runVerify).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("an error is printed and exits 1", async () => {
    runVerify.mockRejectedValue(
      new Error(
        "Did not verify: no branch is configured in .env (PGHOST, PGDATABASE and LAKEBASE_ENDPOINT); run `appkit db init`.",
      ),
    );

    await dbCommand.parseAsync(["verify"], { from: "user" });

    expect(output(error)).toContain("Did not verify: no branch is configured");
    expect(process.exitCode).toBe(1);
  });
});
