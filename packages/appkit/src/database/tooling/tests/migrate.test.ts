import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { applyPendingMigrations, checkAppkitBranch, openBranchPool } =
  vi.hoisted(() => ({
    applyPendingMigrations: vi.fn(),
    checkAppkitBranch: vi.fn(),
    openBranchPool: vi.fn(),
  }));

vi.mock("../../migrations/apply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../migrations/apply")>()),
  applyPendingMigrations,
}));
vi.mock("../guard", () => ({ checkAppkitBranch }));
vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  openBranchPool,
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
  verdict: { appkitOwned: true },
};

const pool = { end: vi.fn(async () => undefined) };

beforeEach(() => {
  applyPendingMigrations.mockReset();
  openBranchPool.mockReset();
  checkAppkitBranch.mockReset();
  checkAppkitBranch.mockResolvedValue(devBranch);
  pool.end.mockClear();
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
    expect(checkAppkitBranch).not.toHaveBeenCalled();
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
    expect(openBranchPool).not.toHaveBeenCalled();
    expect(checkAppkitBranch).not.toHaveBeenCalled();
    expect(report.typesFile).toBe(
      path.join(ctx.root, "shared/appkit-types/database.d.ts"),
    );
    expect(fs.existsSync(report.typesFile)).toBe(true);
  });

  test("generates, regenerates types, applies to the .env branch with the app schema, and ends the pool", async () => {
    const ctx = app(`notes: table("notes", { id: id(), body: text() })`);
    openBranchPool.mockResolvedValue(pool);
    applyPendingMigrations.mockResolvedValue({
      applied: ["0000_migration"],
      adopted: [],
    });

    const report = await runMigrate(ctx, { interactive: false });

    expect(report.generated?.tag).toBe("0000_migration");
    expect(openBranchPool).toHaveBeenCalledWith(ctx);
    expect(applyPendingMigrations).toHaveBeenCalledWith(pool, {
      migrationsFolder: path.join(ctx.root, "config/database/migrations"),
      schemaName: "app",
    });
    expect(report.applied).toEqual(["0000_migration"]);
    expect(report.notApplied).toBeUndefined();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(fs.readFileSync(report.typesFile, "utf-8")).toContain("notes");
  });

  test("applies committed migrations even when schema.ts did not change", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    openBranchPool.mockResolvedValue(null);
    await runMigrate(ctx, { interactive: false });

    openBranchPool.mockResolvedValue(pool);
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
    checkAppkitBranch.mockResolvedValue(null);

    const report = await runMigrate(ctx, { interactive: false });

    expect(report.generated?.tag).toBe("0000_migration");
    expect(applyPendingMigrations).not.toHaveBeenCalled();
    expect(report.notApplied).toMatch(/appkit db init/);
    expect(fs.existsSync(report.typesFile)).toBe(true);
  });

  test("on a branch AppKit did not create for you it generates, never connects, and says why", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    checkAppkitBranch.mockResolvedValue({
      branch: { name: "projects/p/branches/production" },
      verdict: {
        appkitOwned: false,
        reason: "it is the project's default branch",
      },
    });

    const report = await runMigrate(ctx, { interactive: false });

    expect(report.generated?.tag).toBe("0000_migration");
    expect(openBranchPool).not.toHaveBeenCalled();
    expect(applyPendingMigrations).not.toHaveBeenCalled();
    expect(report.notApplied).toBe(
      "production is not an AppKit dev or session branch (it is the project's default branch). Migrations are applied only to branches `appkit db init` created for you; the deployed app applies committed migrations to its own branch",
    );
    expect(fs.existsSync(report.typesFile)).toBe(true);
  });

  test("reports a baseline adopted without running it", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    checkAppkitBranch.mockResolvedValue(null);
    await runMigrate(ctx, { interactive: false });

    checkAppkitBranch.mockResolvedValue(devBranch);
    openBranchPool.mockResolvedValue(pool);
    applyPendingMigrations.mockResolvedValue({
      applied: [],
      adopted: ["0000_baseline"],
    });
    const report = await runMigrate(ctx, { interactive: false });

    expect(report).toMatchObject({ applied: [], adopted: ["0000_baseline"] });
  });

  test("an apply failure ends the pool and says the generated migration was written but not applied", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    openBranchPool.mockResolvedValue(pool);
    const failure = new Error("apply failed");
    applyPendingMigrations.mockRejectedValue(failure);

    const error = (await runMigrate(ctx, { interactive: false }).catch(
      (caught: unknown) => caught,
    )) as Error;

    expect(error.message).toBe(
      `Wrote ${path.join("config/database/migrations", "0000_migration.sql")}, but did not apply it: apply failed`,
    );
    expect(error.cause).toBe(failure);
    expect(pool.end).toHaveBeenCalledOnce();
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
    checkAppkitBranch.mockResolvedValue(null);
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
    checkAppkitBranch.mockResolvedValue(devBranch);
    openBranchPool.mockResolvedValue(pool);
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
    checkAppkitBranch.mockResolvedValue(null);
    await runMigrate(ctx, { interactive: false });

    writeSchema(ctx.root, `notes: table("notes", { id: id(), body: text() })`);
    checkAppkitBranch.mockResolvedValue(devBranch);
    openBranchPool.mockResolvedValue(pool);
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
    checkAppkitBranch.mockRejectedValue(
      new Error("The .env branch projects/p/branches/dev-a does not exist"),
    );

    await expect(runMigrate(ctx, { interactive: false })).rejects.toThrow(
      /^Wrote .*0000_migration\.sql, but did not apply it: The \.env branch .* does not exist$/,
    );
    expect(openBranchPool).not.toHaveBeenCalled();
  });

  test("a failure with nothing generated propagates unchanged", async () => {
    const ctx = app(`notes: table("notes", { id: id() })`);
    checkAppkitBranch.mockResolvedValue(null);
    await runMigrate(ctx, { interactive: false });

    checkAppkitBranch.mockResolvedValue(devBranch);
    openBranchPool.mockResolvedValue(pool);
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
    expect(checkAppkitBranch).not.toHaveBeenCalled();
  });
});
