import { afterEach, describe, expect, test, vi } from "vitest";
import { dbCommand } from "../index";
import { assertSeedSqlAllowed } from "../seed";
import { assertDevSetupAllowed, setupDev } from "../setup-dev";
import { databasePaths, resolveProjectRoot, splitCsv } from "../shared";

describe("dbCommand", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("registers database subcommands", () => {
    expect(dbCommand.name()).toBe("db");
    expect(dbCommand.commands.map((command) => command.name())).toEqual([
      "init",
      "introspect",
      "migration",
      "migrate",
      "seed",
      "setup:dev",
      "types",
      "verify",
    ]);
  });

  test("registers migration subcommands", () => {
    const migration = dbCommand.commands.find(
      (command) => command.name() === "migration",
    );

    expect(migration?.commands.map((command) => command.name())).toEqual([
      "generate",
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

  test("setup:dev refuses production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => assertDevSetupAllowed()).toThrow(/production/);
  });

  test("setup:dev refuses CI unless forced", () => {
    vi.stubEnv("CI", "true");

    expect(() => assertDevSetupAllowed()).toThrow(/CI/);
    expect(() => assertDevSetupAllowed({ force: true })).not.toThrow();
  });

  test("seed rejects DDL by default", () => {
    expect(() => assertSeedSqlAllowed("CREATE TABLE users (id int);")).toThrow(
      /data-only/,
    );
  });

  test("seed allows DDL with explicit flag", () => {
    expect(() =>
      assertSeedSqlAllowed("CREATE TABLE users (id int);", { allowDdl: true }),
    ).not.toThrow();
  });

  test("seed allows idempotent insert data", () => {
    expect(() =>
      assertSeedSqlAllowed(`
        INSERT INTO users (email)
        VALUES ('demo@databricks.com')
        ON CONFLICT DO NOTHING;
      `),
    ).not.toThrow();
  });

  test("setup:dev runs generate, migrate, seed, verify in order", async () => {
    const calls: string[] = [];

    await setupDev(
      { name: "init", seed: true, force: true },
      {
        generateMigration: async () => {
          calls.push("generate");
        },
        migrateUp: async () => {
          calls.push("migrate");
        },
        runSeed: async () => {
          calls.push("seed");
        },
        verifyDatabase: async () => {
          calls.push("verify");
        },
      },
    );

    expect(calls).toEqual(["generate", "migrate", "seed", "verify"]);
  });
});
