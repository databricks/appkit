import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { applyPendingMigrations, resolveEnvBranch, withBranchPool } = vi.hoisted(
  () => ({
    applyPendingMigrations: vi.fn(),
    resolveEnvBranch: vi.fn(),
    withBranchPool: vi.fn(),
  }),
);

vi.mock("../../migrations/apply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../migrations/apply")>()),
  applyPendingMigrations,
}));
vi.mock("../guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../guard")>()),
  resolveEnvBranch,
}));
vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  withBranchPool,
}));

import { MigrationApplyError } from "../../migrations/apply";
import type { DbContext } from "../context";
import { runMigrate } from "../migrate";

const builder = path.resolve(
  import.meta.dirname,
  "../../schema-builder/index.ts",
);
const roots: string[] = [];

function writeSchema(root: string, tables: string): void {
  const file = path.join(root, "config/database/schema.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `import { defineSchema, id, text } from ${JSON.stringify(builder)};
     export const schema = defineSchema(({ table }) => ({ ${tables} }));`,
  );
}

function app(tables: string): DbContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-db-migrate-"));
  roots.push(root);
  writeSchema(root, tables);
  return {
    root,
    env: {},
    workspace: () => {
      throw new Error("no workspace calls expected");
    },
    api: () => {
      throw new Error("no Lakebase API calls expected");
    },
  };
}

const devBranch = {
  branch: { name: "projects/p/branches/dev-alice-3f9a2c" },
  kind: "dev",
};

const pool = {};

beforeEach(() => {
  applyPendingMigrations.mockReset();
  withBranchPool
    .mockReset()
    .mockImplementation((_ctx, fn: (p: unknown) => unknown) => fn(pool));
  resolveEnvBranch.mockReset();
  resolveEnvBranch.mockResolvedValue(devBranch);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("runMigrate", () => {
  test("without schema.ts it points to introspect before touching anything", async () => {
    const ctx = app("");
    fs.rmSync(path.join(ctx.root, "config/database/schema.ts"));

    await expect(runMigrate(ctx, { interactive: false })).rejects.toThrow(
      "No config/database/schema.ts yet, so there is nothing to migrate. Run `appkit db introspect` to write it from the branch's tables, or create it.",
    );
    expect(resolveEnvBranch).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(ctx.root, "config/database/migrations")),
    ).toBe(false);
  });

  test("an empty schema generates nothing, applies nothing, and still writes database.d.ts", async () => {
    const ctx = app("");
    const report = await runMigrate(ctx, { interactive: false });

    expect(report.generated).toBeNull();
    expect(report.applied).toEqual([]);
    expect(report.notApplied).toMatch(/no migrations/);
    expect(withBranchPool).not.toHaveBeenCalled();
    expect(resolveEnvBranch).not.toHaveBeenCalled();
    expect(report.typesFile).toBe(
      path.join(ctx.root, "shared/appkit-types/database.d.ts"),
    );
    expect(fs.existsSync(report.typesFile)).toBe(true);
  });

  test("generates, regenerates types, and applies to the .env branch with the app schema", async () => {
    const ctx = app(`notes: table("notes", { id: id(), body: text() })`);
    applyPendingMigrations.mockResolvedValue({
      applied: ["0000_migration"],
      adopted: [],
    });

    const report = await runMigrate(ctx, { interactive: false });

    expect(report.generated?.tag).toBe("0000_migration");
    expect(withBranchPool).toHaveBeenCalledWith(ctx, expect.any(Function));
    expect(applyPendingMigrations).toHaveBeenCalledWith(pool, {
      migrationsFolder: path.join(ctx.root, "config/database/migrations"),
      schemaName: "app",
    });
    expect(report.applied).toEqual(["0000_migration"]);
    expect(report.notApplied).toBeUndefined();
    expect(fs.readFileSync(report.typesFile, "utf-8")).toContain("notes");
  });

  test("applies committed migrations even when schema.ts did not change", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    resolveEnvBranch.mockResolvedValue(null);
    await runMigrate(ctx, { interactive: false });

    resolveEnvBranch.mockResolvedValue(devBranch);
    applyPendingMigrations.mockResolvedValue({
      applied: ["0000_migration"],
      adopted: [],
    });
    const report = await runMigrate(ctx, { interactive: false });

    expect(report.generated).toBeNull();
    expect(report.applied).toEqual(["0000_migration"]);
  });

  test("without a configured branch it still generates, and says why nothing was applied", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    resolveEnvBranch.mockResolvedValue(null);

    const report = await runMigrate(ctx, { interactive: false });

    expect(report.generated?.tag).toBe("0000_migration");
    expect(applyPendingMigrations).not.toHaveBeenCalled();
    expect(report.notApplied).toBe(
      "no branch is configured in .env (PGHOST, PGDATABASE and LAKEBASE_ENDPOINT); run `appkit db init`",
    );
    expect(fs.existsSync(report.typesFile)).toBe(true);
  });

  test("on a branch AppKit did not create for you it generates, never connects, and says why", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    resolveEnvBranch.mockResolvedValue({
      branch: { name: "projects/p/branches/production" },
      kind: "default",
      reason: "it is the project's default branch",
    });

    const report = await runMigrate(ctx, { interactive: false });

    expect(report.generated?.tag).toBe("0000_migration");
    expect(withBranchPool).not.toHaveBeenCalled();
    expect(applyPendingMigrations).not.toHaveBeenCalled();
    expect(report.notApplied).toBe(
      "production is not your dev or session branch (it is the project's default branch). Migrations are applied only to branches `appkit db init` created for you; the deployed app applies committed migrations to its own branch",
    );
    expect(fs.existsSync(report.typesFile)).toBe(true);
  });

  test("reports a baseline adopted without running it", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    resolveEnvBranch.mockResolvedValue(null);
    await runMigrate(ctx, { interactive: false });

    resolveEnvBranch.mockResolvedValue(devBranch);
    applyPendingMigrations.mockResolvedValue({
      applied: [],
      adopted: ["0000_baseline"],
    });
    const report = await runMigrate(ctx, { interactive: false });

    expect(report).toMatchObject({ applied: [], adopted: ["0000_baseline"] });
  });

  test("an apply failure says the generated migration was written but not applied", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    const failure = new Error("apply failed");
    applyPendingMigrations.mockRejectedValue(failure);

    const error = (await runMigrate(ctx, { interactive: false }).catch(
      (caught: unknown) => caught,
    )) as Error;

    expect(error.message).toBe(
      `Wrote ${path.join("config/database/migrations", "0000_migration.sql")}, but did not apply it: apply failed`,
    );
    expect(error.cause).toBe(failure);
    expect(
      fs.existsSync(
        path.join(ctx.root, "config/database/migrations/0000_migration.sql"),
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(ctx.root, "shared/appkit-types/database.d.ts"),
        "utf-8",
      ),
    ).toContain("notes");
  });

  test("when the migration this run wrote fails to apply, it is removed so a fix in schema.ts can replace it", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    resolveEnvBranch.mockResolvedValue(null);
    await runMigrate(ctx, { interactive: false });
    const folder = path.join(ctx.root, "config/database/migrations");
    const journal = fs.readFileSync(
      path.join(folder, "meta/_journal.json"),
      "utf-8",
    );

    writeSchema(
      ctx.root,
      `notes: table("notes", { id: id(), title: text().notNull() })`,
    );
    resolveEnvBranch.mockResolvedValue(devBranch);
    const failure = new MigrationApplyError({
      step: "Applying migrations",
      failed: "0001_migration",
      pending: ["0001_migration"],
      cause: Object.assign(
        new Error('column "title" of relation "notes" contains null values'),
        { code: "23502" },
      ),
    });
    applyPendingMigrations.mockRejectedValue(failure);

    const error = (await runMigrate(ctx, { interactive: false }).catch(
      (caught: unknown) => caught,
    )) as Error;

    expect(error.message).toBe(
      `${failure.message} Removed ${path.join("config/database/migrations", "0001_migration.sql")}, so the next run writes it again from config/database/schema.ts. Change config/database/schema.ts or the branch's data, then rerun \`appkit db migrate\`.`,
    );
    expect(error.cause).toBe(failure);
    expect(fs.existsSync(path.join(folder, "0001_migration.sql"))).toBe(false);
    expect(fs.existsSync(path.join(folder, "meta/0001_snapshot.json"))).toBe(
      false,
    );
    expect(
      fs.readFileSync(path.join(folder, "meta/_journal.json"), "utf-8"),
    ).toBe(journal);
  });

  test("when an earlier migration fails, the one this run wrote stays for the next try", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    resolveEnvBranch.mockResolvedValue(null);
    await runMigrate(ctx, { interactive: false });

    writeSchema(ctx.root, `notes: table("notes", { id: id(), body: text() })`);
    resolveEnvBranch.mockResolvedValue(devBranch);
    applyPendingMigrations.mockRejectedValue(
      new MigrationApplyError({
        step: "Applying migrations",
        failed: "0000_migration",
        pending: ["0000_migration", "0001_migration"],
        cause: Object.assign(new Error("duplicate key"), { code: "23505" }),
      }),
    );

    await expect(runMigrate(ctx, { interactive: false })).rejects.toThrow(
      /^Wrote .*0001_migration\.sql, but did not apply it: Migration 0000_migration failed/,
    );
    expect(
      fs.existsSync(
        path.join(ctx.root, "config/database/migrations/0001_migration.sql"),
      ),
    ).toBe(true);
  });

  test("a guard failure after generating says so too, and never connects", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    resolveEnvBranch.mockRejectedValue(
      new Error("The .env branch projects/p/branches/dev-a does not exist"),
    );

    await expect(runMigrate(ctx, { interactive: false })).rejects.toThrow(
      /^Wrote .*0000_migration\.sql, but did not apply it: The \.env branch .* does not exist$/,
    );
    expect(withBranchPool).not.toHaveBeenCalled();
  });

  test("a failure with nothing generated propagates unchanged", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    resolveEnvBranch.mockResolvedValue(null);
    await runMigrate(ctx, { interactive: false });

    resolveEnvBranch.mockResolvedValue(devBranch);
    const failure = new Error("apply failed");
    applyPendingMigrations.mockRejectedValue(failure);

    await expect(runMigrate(ctx, { interactive: false })).rejects.toBe(failure);
  });

  test("a schema.ts that fails to import names the import error, not the runtime hint", async () => {
    const ctx = app(`notes: table("notes", { id: id( })`);

    const error = (await runMigrate(ctx, { interactive: false }).catch(
      (caught: unknown) => caught,
    )) as Error;

    expect(error.message).toBe("Could not load config/database/schema.ts.");
    expect((error.cause as Error).message).toMatch(/schema\.ts:\d+:\d+/);
    expect(resolveEnvBranch).not.toHaveBeenCalled();
  });
});
