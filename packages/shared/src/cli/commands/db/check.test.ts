import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

const { createDbContext, runCheck } = vi.hoisted(() => ({
  createDbContext: vi.fn(() => ({ root: "/app", env: {} })),
  runCheck: vi.fn(),
}));

// The tooling is an ambient module loaded with a dynamic import.
vi.mock("@databricks/appkit/database-tooling", () => ({
  createDbContext,
  runCheck,
}));

import { dbCommand } from "./index";

let log: MockInstance;
let error: MockInstance;

function output(spy: MockInstance): string {
  return spy.mock.calls.map((call) => call.join(" ")).join("\n");
}

beforeEach(() => {
  runCheck.mockReset();
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("appkit db check", () => {
  test("is registered under the db group", () => {
    expect(dbCommand.commands.map((command) => command.name())).toContain(
      "check",
    );
  });

  test("a sound history prints what was checked and exits 0", async () => {
    runCheck.mockResolvedValue({
      migrations: ["0000_migration", "0001_migration"],
      problems: [],
      ok: true,
    });

    await dbCommand.parseAsync(["check"], { from: "user" });

    expect(runCheck).toHaveBeenCalledWith({ root: "/app", env: {} });
    expect(output(log)).toContain(
      "The 2 committed migrations are in order with every file, and config/database/schema.ts has no change without a migration",
    );
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("no migrations and no tables is a pass", async () => {
    runCheck.mockResolvedValue({ migrations: [], problems: [], ok: true });

    await dbCommand.parseAsync(["check"], { from: "user" });

    expect(output(log)).toContain(
      "config/database/schema.ts declares nothing a migration would create, and no migration is committed",
    );
  });

  test("lists each problem and exits 1", async () => {
    runCheck.mockResolvedValue({
      migrations: ["0000_migration"],
      problems: [
        "config/database/schema.ts changed since 0000_migration, so the deployed app would not get the change. Run `appkit db migrate` and commit the migration it writes.",
      ],
      ok: false,
    });

    await dbCommand.parseAsync(["check"], { from: "user" });

    expect(output(log)).toContain(
      "config/database/schema.ts changed since 0000_migration",
    );
    expect(output(error)).toContain(
      "The committed migrations are not ready to deploy. Fix the above, then run `appkit db check` again.",
    );
    expect(process.exitCode).toBe(1);
  });

  test("an error is printed and exits 1", async () => {
    runCheck.mockRejectedValue(
      new Error(
        "No config/database/schema.ts yet, so there is nothing to check.",
      ),
    );

    await dbCommand.parseAsync(["check"], { from: "user" });

    expect(output(error)).toContain("there is nothing to check");
    expect(process.exitCode).toBe(1);
  });
});
