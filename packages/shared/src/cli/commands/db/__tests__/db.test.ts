import { describe, expect, test } from "vitest";
import { dbCommand } from "../index";
import { databasePaths, resolveProjectRoot, splitCsv } from "../shared";

describe("dbCommand", () => {
  test("registers database subcommands", () => {
    expect(dbCommand.name()).toBe("db");
    expect(dbCommand.commands.map((command) => command.name())).toEqual([
      "introspect",
      "generate",
      "migrate",
      "verify",
    ]);
  });

  test("registers migrate subcommands", () => {
    const migrate = dbCommand.commands.find(
      (command) => command.name() === "migrate",
    );

    expect(migrate?.commands.map((command) => command.name())).toEqual([
      "up",
      "status",
      "reset",
    ]);
  });

  test("resolves conventional database paths", () => {
    const root = "/tmp/appkit-test-app";

    expect(databasePaths(root)).toMatchObject({
      root,
      configDir: "/tmp/appkit-test-app/config/database",
      schemaFile: "/tmp/appkit-test-app/config/database/schema.ts",
      migrationsDir: "/tmp/appkit-test-app/config/database/migrations",
      baselineFile:
        "/tmp/appkit-test-app/config/database/migrations/0000_baseline.json",
    });
  });

  test("splits comma-separated flags", () => {
    expect(splitCsv("app, public,, analytics ")).toEqual([
      "app",
      "public",
      "analytics",
    ]);
  });

  test("falls back to the start directory when no package root is found", () => {
    expect(resolveProjectRoot("/")).toBe("/");
  });
});
