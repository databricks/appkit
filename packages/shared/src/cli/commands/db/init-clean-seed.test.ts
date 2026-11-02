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
  runInit: vi.fn(),
  previewClean: vi.fn(),
  runClean: vi.fn(),
  deleteSessionBranch: vi.fn(),
  runSeed: vi.fn(),
}));
const prompts = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: vi.fn((value: unknown) => typeof value === "symbol"),
}));

vi.mock("@databricks/appkit/beta/database-tooling", () => tooling);
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

const migrate = {
  generated: null,
  applied: ["0000_migration"],
  typesFile: `${process.cwd()}/shared/appkit-types/database.d.ts`,
};
const report = {
  mode: "dev",
  branch: "projects/p/branches/dev-alice-3f9a2c",
  created: true,
  sourceBranch: "projects/p/branches/production",
  expireTime: null,
  endpoint: "projects/p/branches/dev-alice-3f9a2c/endpoints/primary",
  endpointCreated: false,
  host: "ep-1.example.com",
  database: "databricks_postgres",
  user: "alice@example.com",
  role: {
    name: "projects/p/branches/dev-alice-3f9a2c/roles/alice",
    action: "kept",
  },
  handedOff: "11111111-2222-3333-4444-555555555555",
  envFile: "/app/.env",
  installed: null,
  start: { kind: "migrate", migrate },
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

const init = (...args: string[]) =>
  dbCommand.parseAsync(["init", ...args], { from: "user" });
const clean = (...args: string[]) =>
  dbCommand.parseAsync(["clean", ...args], { from: "user" });
const initOptions = () => tooling.runInit.mock.calls.at(-1)?.[1];

beforeEach(() => {
  resetOptionValues();
  for (const mock of Object.values(tooling)) mock.mockReset();
  prompts.confirm.mockReset();
  tooling.createDbContext.mockReturnValue({ root: "/app", env: {} });
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
  test("registers init, migrate, introspect, clean, seed, verify and check", () => {
    expect(dbCommand.commands.map((c) => c.name())).toEqual([
      "init",
      "migrate",
      "introspect",
      "clean",
      "seed",
      "verify",
      "check",
    ]);
  });

  test("init only sets up a dev or session branch: there is no option to pick another one", () => {
    const command = dbCommand.commands.find((c) => c.name() === "init");
    expect(command?.options.map((o) => o.long)).toEqual([
      "--session",
      "--dev",
      "--ttl",
      "--schema",
      "--yes",
    ]);
  });

  test("asks nothing, even on a TTY: the tooling picks the mode and the start", async () => {
    setTTY(true);
    await init();

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(tooling.runInit).toHaveBeenCalledWith(
      { root: "/app", env: {} },
      { interactive: true, onStep: expect.any(Function) },
    );
  });

  test("flags map to the options; --yes turns off the rename prompts", async () => {
    await init("--session", "--ttl", "1h", "--schema", "none", "--yes");

    expect(initOptions()).toEqual({
      mode: "session",
      schema: "none",
      ttl: "1h",
      interactive: false,
      onStep: expect.any(Function),
    });

    resetOptionValues();
    await init("--dev");
    expect(initOptions()).toMatchObject({ mode: "dev" });
  });

  test("--session and --dev conflict", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(init("--session", "--dev")).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalled();
    expect(tooling.runInit).not.toHaveBeenCalled();
  });

  test("prints each step as it happens", async () => {
    tooling.runInit.mockImplementation(async (_ctx, options) => {
      options.onStep("Creating dev-alice-3f9a2c from production");
      return report;
    });
    await init();
    expect(output(log)).toContain("Creating dev-alice-3f9a2c from production");
  });

  test("prints what it did", async () => {
    await init();

    const printed = output(log);
    expect(printed).toContain(
      "Branch dev-alice-3f9a2c (created from production)",
    );
    expect(printed).toContain("Endpoint primary: ep-1.example.com");
    expect(printed).toContain("Role alice@example.com (DATABRICKS_SUPERUSER)");
    expect(printed).toContain(
      "The app schema is yours: it belonged to 11111111-2222-3333-4444-555555555555",
    );
    expect(printed).toContain(
      "Pointed .env at dev-alice-3f9a2c (database databricks_postgres)",
    );
    expect(printed).toContain("Applied 0000_migration to the .env branch");
    expect(printed).not.toContain("Installed drizzle-kit");
  });

  test("a session branch reports when it expires, and an install is reported", async () => {
    tooling.runInit.mockResolvedValue({
      ...report,
      mode: "session",
      branch: "projects/p/branches/session-3f9a2c-k2x9",
      created: false,
      expireTime: "2026-10-26T12:00:00Z",
      handedOff: null,
      installed: "npm install --save-dev --save-exact drizzle-kit@0.31.10",
      start: { kind: "none" },
    });
    await init();

    const printed = output(log);
    expect(printed).toContain(
      "Branch session-3f9a2c-k2x9 (reused, expires 2026-10-26T12:00:00Z)",
    );
    expect(printed).toContain(
      "Installed drizzle-kit (npm install --save-dev --save-exact drizzle-kit@0.31.10)",
    );
    expect(printed).toContain("Left the schema as it is");
    expect(printed).not.toContain("The app schema is yours");
  });

  test("a clean start reports the drop, what it took along, then the migrations", async () => {
    tooling.runInit.mockResolvedValue({
      ...report,
      start: {
        kind: "clean",
        clean: {
          branch: report.branch,
          schemaName: "app",
          dependents: ["view reports.summary"],
        },
        migrate,
      },
    });
    await init("--schema", "clean", "--yes");

    const printed = output(log);
    expect(printed).toContain("Dropped schema app on dev-alice-3f9a2c");
    expect(printed).toContain(
      "Also removed, because they depended on it: view reports.summary",
    );
    expect(printed).toContain("Applied 0000_migration to the .env branch");
  });

  test("--schema clean without a TTY needs --yes, and stops before any API call", async () => {
    await init("--schema", "clean");

    expect(output(error)).toContain(
      "Refusing to run `--schema clean` without confirmation in a non-interactive shell. Pass --yes.",
    );
    expect(tooling.runInit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("--schema clean on a TTY asks first; a no cancels with exit code 1", async () => {
    setTTY(true);
    prompts.confirm.mockResolvedValueOnce(false);
    await init("--schema", "clean");

    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(tooling.runInit).not.toHaveBeenCalled();
    expect(output(log)).toContain("Cancelled");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    resetOptionValues();
    prompts.confirm.mockResolvedValueOnce(true);
    await init("--schema", "clean");
    expect(initOptions()).toMatchObject({ schema: "clean" });
  });

  test("an error is printed and exits 1", async () => {
    tooling.runInit.mockRejectedValue(
      new Error(
        "Creating dev-a needs CAN MANAGE on projects/p. Ask a project owner for it, then rerun `appkit db init`.",
      ),
    );
    await init("--yes");
    expect(output(error)).toContain("needs CAN MANAGE on projects/p");
    expect(process.exitCode).toBe(1);
  });
});

describe("appkit db clean", () => {
  const cleaned = {
    branch: "projects/p/branches/dev-a",
    schemaName: "app",
    dependents: [],
  };

  test("refuses without --yes when there is no TTY, before any API call", async () => {
    await clean();

    expect(output(error)).toContain(
      "Refusing to clean without confirmation in a non-interactive shell. Pass --yes.",
    );
    expect(tooling.previewClean).not.toHaveBeenCalled();
    expect(tooling.runClean).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("on a TTY it names the branch and what else goes, then asks; no cancels with exit code 1", async () => {
    setTTY(true);
    tooling.previewClean.mockResolvedValue({
      ...cleaned,
      dependents: ["view reports.summary"],
    });
    prompts.confirm.mockResolvedValueOnce(false);
    await clean();

    expect(output(log)).toContain(
      "Dropping schema app also removes these objects outside it, which depend on it: view reports.summary",
    );
    expect(prompts.confirm.mock.calls[0]?.[0].message).toBe(
      "Remove every object in schema app on dev-a, including the migration journal?",
    );
    expect(tooling.runClean).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    prompts.confirm.mockResolvedValueOnce(true);
    tooling.runClean.mockResolvedValue(cleaned);
    await clean();
    expect(tooling.runClean).toHaveBeenCalledOnce();
    expect(output(log)).toContain("Dropped schema app on dev-a");
  });

  test("--yes cleans without asking; public says only your objects went", async () => {
    tooling.runClean.mockResolvedValue({ ...cleaned, schemaName: "public" });
    await clean("--yes");

    expect(tooling.previewClean).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(output(log)).toContain(
      "Removed your objects in schema public on dev-a",
    );
  });

  test("--delete-branch deletes this checkout's session branch without a prompt", async () => {
    tooling.deleteSessionBranch.mockResolvedValue({
      branch: "projects/p/branches/session-3f9a2c-k2x9",
    });
    await clean("--delete-branch");

    expect(tooling.runClean).not.toHaveBeenCalled();
    expect(output(log)).toContain("Deleted session-3f9a2c-k2x9");
    expect(process.exitCode).toBeUndefined();
  });

  test("the guard's refusal is printed and exits 1", async () => {
    tooling.runClean.mockRejectedValue(
      new Error(
        "Refusing to clean production: it is the project's default branch.",
      ),
    );
    await clean("--yes");
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
