import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

const tooling = vi.hoisted(() => ({
  createDbContext: vi.fn(() => ({ root: "/app", env: {} })),
  resolveInitDefaults: vi.fn(),
  schemaStartsFor: vi.fn((hasSchema: boolean) =>
    hasSchema ? ["migrate", "introspect", "clean"] : ["introspect"],
  ),
  defaultSchemaStart: vi.fn((hasSchema: boolean) =>
    hasSchema ? "migrate" : "introspect",
  ),
  runInit: vi.fn(),
  runClean: vi.fn(),
  runSeed: vi.fn(),
}));
const prompts = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn((value: unknown) => typeof value === "symbol"),
}));

vi.mock("@databricks/appkit/database-tooling", () => tooling);
vi.mock("@clack/prompts", () => prompts);

import { dbCommand } from "./index";

let log: MockInstance;
let error: MockInstance;
const output = (spy: MockInstance) =>
  spy.mock.calls.map((call) => call.join(" ")).join("\n");

function setTTY(value: boolean | undefined) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}
const ttyBefore = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

const report = {
  mode: "dev",
  branch: "projects/p/branches/dev-alice-3f9a2c",
  created: true,
  sourceBranch: "projects/p/branches/production",
  endpoint: "projects/p/branches/dev-alice-3f9a2c/endpoints/primary",
  endpointCreated: false,
  host: "ep-1.example.com",
  database: "databricks_postgres",
  user: "alice@example.com",
  role: {
    name: "projects/p/branches/dev-alice-3f9a2c/roles/alice",
    action: "kept",
  },
  handedOff: ["11111111-2222-3333-4444-555555555555"],
  envFile: "/app/.env",
  cleaned: false,
  schema: {
    generated: null,
    applied: ["0000_migration"],
    typesFile: `${process.cwd()}/shared/appkit-types/database.d.ts`,
  },
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
  for (const mock of [
    tooling.createDbContext,
    tooling.resolveInitDefaults,
    tooling.runInit,
    tooling.runClean,
    tooling.runSeed,
    prompts.select,
    prompts.confirm,
  ])
    mock.mockReset();
  tooling.createDbContext.mockReturnValue({ root: "/app", env: {} });
  tooling.resolveInitDefaults.mockResolvedValue({
    mode: null,
    hasSchema: true,
  });
  tooling.runInit.mockResolvedValue(report);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setTTY(undefined);
  Object.defineProperty(process.stdin, "isTTY", {
    value: ttyBefore.stdin,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: ttyBefore.stdout,
    configurable: true,
  });
  process.exitCode = undefined;
});

describe("appkit db init", () => {
  test("registers init, migrate, introspect, clean and seed", () => {
    expect(dbCommand.commands.map((c) => c.name())).toEqual([
      "init",
      "migrate",
      "introspect",
      "clean",
      "seed",
    ]);
  });

  test("--yes skips every prompt, even on a TTY; flags map to the choices", async () => {
    setTTY(true);
    await dbCommand.parseAsync(["init", "--new", "session", "--yes"], {
      from: "user",
    });

    expect(prompts.select).not.toHaveBeenCalled();
    expect(tooling.runInit).toHaveBeenCalledWith(
      { root: "/app", env: {} },
      { mode: "session", schemaStart: "migrate" },
      { interactive: false },
    );
  });

  test("init only sets up a dev or session branch: there is no option to pick another one", () => {
    const init = dbCommand.commands.find((c) => c.name() === "init");
    expect(init?.options.map((o) => o.long)).toEqual([
      "--new",
      "--schema",
      "--yes",
    ]);
  });

  test("--schema none leaves the schema alone", async () => {
    await dbCommand.parseAsync(
      ["init", "--new", "dev", "--schema", "none", "--yes"],
      { from: "user" },
    );

    expect(tooling.runInit).toHaveBeenCalledWith(
      expect.anything(),
      { mode: "dev", schemaStart: null },
      { interactive: false },
    );
  });

  test("without a TTY: the mode of the .env branch, else dev; schema migrate", async () => {
    await dbCommand.parseAsync(["init"], { from: "user" });
    expect(tooling.runInit).toHaveBeenLastCalledWith(
      expect.anything(),
      { mode: "dev", schemaStart: "migrate" },
      { interactive: false },
    );

    tooling.resolveInitDefaults.mockResolvedValue({
      mode: "session",
      hasSchema: true,
    });
    await dbCommand.parseAsync(["init"], { from: "user" });
    expect(tooling.runInit).toHaveBeenLastCalledWith(
      expect.anything(),
      { mode: "session", schemaStart: "migrate" },
      { interactive: false },
    );
    expect(prompts.select).not.toHaveBeenCalled();
  });

  test("on a TTY it asks for dev or session, then the schema start", async () => {
    setTTY(true);
    prompts.select
      .mockResolvedValueOnce("session")
      .mockResolvedValueOnce("none");

    await dbCommand.parseAsync(["init"], { from: "user" });

    expect(prompts.select).toHaveBeenCalledTimes(2);
    expect(
      prompts.select.mock.calls[0]?.[0].options.map(
        (o: { value: string }) => o.value,
      ),
    ).toEqual(["dev", "session"]);
    expect(prompts.select.mock.calls[0]?.[0].initialValue).toBe("dev");
    expect(tooling.runInit).toHaveBeenCalledWith(
      expect.anything(),
      { mode: "session", schemaStart: null },
      { interactive: true },
    );
  });

  test("a new branch offers migrate, introspect and clean, defaulting to migrate", async () => {
    setTTY(true);
    prompts.select
      .mockResolvedValueOnce("dev")
      .mockResolvedValueOnce("introspect");

    await dbCommand.parseAsync(["init"], { from: "user" });

    expect(
      prompts.select.mock.calls[1]?.[0].options.map(
        (o: { value: string }) => o.value,
      ),
    ).toEqual(["migrate", "introspect", "clean", "none"]);
    expect(prompts.select.mock.calls[1]?.[0].initialValue).toBe("migrate");
    expect(tooling.runInit).toHaveBeenCalledWith(
      expect.anything(),
      { mode: "dev", schemaStart: "introspect" },
      { interactive: true },
    );
  });

  test("without schema.ts only introspect is offered, and it is the default", async () => {
    setTTY(true);
    tooling.resolveInitDefaults.mockResolvedValue({
      mode: null,
      hasSchema: false,
    });
    prompts.select
      .mockResolvedValueOnce("session")
      .mockResolvedValueOnce("introspect");

    await dbCommand.parseAsync(["init"], { from: "user" });

    const schemaPrompt = prompts.select.mock.calls[1]?.[0];
    expect(schemaPrompt.options).toEqual([
      {
        value: "introspect",
        label: "Introspect",
        hint: "there is no schema.ts yet: write it from the branch's tables",
      },
      { value: "none", label: "Leave the schema as it is" },
    ]);
    expect(schemaPrompt.initialValue).toBe("introspect");
    expect(tooling.runInit).toHaveBeenCalledWith(
      expect.anything(),
      { mode: "session", schemaStart: "introspect" },
      { interactive: true },
    );
  });

  test("without schema.ts and without prompts the start is introspect", async () => {
    tooling.resolveInitDefaults.mockResolvedValue({
      mode: null,
      hasSchema: false,
    });

    await dbCommand.parseAsync(["init", "--new", "dev", "--yes"], {
      from: "user",
    });

    expect(tooling.runInit).toHaveBeenCalledWith(
      expect.anything(),
      { mode: "dev", schemaStart: "introspect" },
      { interactive: false },
    );
  });

  test("on a TTY, a mode implied by the .env branch is not asked again", async () => {
    setTTY(true);
    tooling.resolveInitDefaults.mockResolvedValue({
      mode: "session",
      hasSchema: true,
    });
    prompts.select.mockResolvedValueOnce("migrate");

    await dbCommand.parseAsync(["init"], { from: "user" });

    expect(prompts.select).toHaveBeenCalledOnce();
    expect(prompts.select.mock.calls[0]?.[0].message).toBe(
      "How should the branch's schema start?",
    );
    expect(tooling.runInit).toHaveBeenCalledWith(
      expect.anything(),
      { mode: "session", schemaStart: "migrate" },
      { interactive: true },
    );
  });

  test("a cancelled prompt stops before any change", async () => {
    setTTY(true);
    prompts.select.mockResolvedValueOnce(Symbol("cancel"));

    await dbCommand.parseAsync(["init"], { from: "user" });

    expect(tooling.runInit).not.toHaveBeenCalled();
    expect(output(log)).toContain("Cancelled");
    expect(process.exitCode).toBeUndefined();
  });

  test("prints what it did", async () => {
    await dbCommand.parseAsync(["init", "--new", "dev", "--yes"], {
      from: "user",
    });

    const printed = output(log);
    expect(printed).toContain(
      "Branch dev-alice-3f9a2c (created from production)",
    );
    expect(printed).toContain("Endpoint primary — ep-1.example.com");
    expect(printed).toContain("Role alice@example.com (DATABRICKS_SUPERUSER)");
    expect(printed).toContain(
      "Handed the objects owned by 11111111-2222-3333-4444-555555555555 to you",
    );
    expect(printed).toContain(
      "Pointed .env at dev-alice-3f9a2c (database databricks_postgres)",
    );
    expect(printed).toContain("Applied 0000_migration to the .env branch");
  });

  test("an error is printed and exits 1", async () => {
    tooling.runInit.mockRejectedValue(
      new Error(
        "Lakebase: create branch failed: creating dev-a needs CAN MANAGE on projects/p.",
      ),
    );
    await dbCommand.parseAsync(["init", "--yes"], { from: "user" });
    expect(output(error)).toContain("needs CAN MANAGE on projects/p");
    expect(process.exitCode).toBe(1);
  });
});

describe("appkit db clean", () => {
  test("refuses without --yes when there is no TTY, before any API call", async () => {
    await dbCommand.parseAsync(["clean"], { from: "user" });

    expect(output(error)).toContain(
      "Refusing to clean without confirmation in a non-interactive shell. Pass --yes.",
    );
    expect(tooling.runClean).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("asks for confirmation on a TTY; no means nothing is removed", async () => {
    setTTY(true);
    prompts.confirm.mockResolvedValueOnce(false);
    await dbCommand.parseAsync(["clean"], { from: "user" });
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(tooling.runClean).not.toHaveBeenCalled();

    prompts.confirm.mockResolvedValueOnce(true);
    tooling.runClean.mockResolvedValue({
      branch: "projects/p/branches/dev-a",
      schemaName: "app",
    });
    await dbCommand.parseAsync(["clean"], { from: "user" });
    expect(tooling.runClean).toHaveBeenCalledOnce();
    expect(output(log)).toContain(
      "Removed every object in schema app on dev-a",
    );
  });

  test("--yes cleans without asking", async () => {
    tooling.runClean.mockResolvedValue({
      branch: "projects/p/branches/dev-a",
      schemaName: "app",
    });
    await dbCommand.parseAsync(["clean", "--yes"], { from: "user" });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(tooling.runClean).toHaveBeenCalledOnce();
  });

  test("the guard's refusal is printed and exits 1", async () => {
    tooling.runClean.mockRejectedValue(
      new Error(
        "Refusing to clean production: it is the project's default branch.",
      ),
    );
    await dbCommand.parseAsync(["clean", "--yes"], { from: "user" });
    expect(output(error)).toContain("Refusing to clean production");
    expect(process.exitCode).toBe(1);
  });
});

describe("appkit db seed", () => {
  test("prints the seed file and branch", async () => {
    tooling.runSeed.mockResolvedValue({
      branch: "projects/p/branches/dev-a",
      file: `${process.cwd()}/config/database/seed.sql`,
    });
    await dbCommand.parseAsync(["seed"], { from: "user" });
    expect(output(log)).toContain("Ran config/database/seed.sql on dev-a");
  });

  test("a missing seed file exits 1", async () => {
    tooling.runSeed.mockRejectedValue(
      new Error("No seed file at config/database/seed.sql."),
    );
    await dbCommand.parseAsync(["seed"], { from: "user" });
    expect(process.exitCode).toBe(1);
  });
});
