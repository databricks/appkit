import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { checkAppkitBranch, markMigrationsApplied, openBranchPool } = vi.hoisted(
  () => ({
    checkAppkitBranch: vi.fn(),
    markMigrationsApplied: vi.fn(),
    openBranchPool: vi.fn(),
  }),
);

vi.mock("../../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../context")>()),
  openBranchPool,
}));
vi.mock("../../guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../guard")>()),
  checkAppkitBranch,
}));
vi.mock("../../../migrations/apply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../migrations/apply")>()),
  markMigrationsApplied,
}));

import { loadDefaultDatabaseSchema } from "../../../../plugins/database/load-schema";
import { readJournal } from "../../../migrations/paths";
import { generateMigrationFiles } from "../../migrations";
import { cleanupTempApps, fakeContext, tempApp } from "../../tests/fakes";
import type { ColumnRow } from "../catalog";
import { IntrospectRefusedError, runIntrospect } from "../index";
import { BUILDER, catalogResponder, columnRow } from "./fixture";

const SCHEMA = "config/database/schema.ts";
const MIGRATIONS = "config/database/migrations";
const DEV = "projects/p/branches/dev-alice-3f9a2c";
const PRODUCTION = "projects/p/branches/production";

const previousSchema = `import { defineSchema, id, text } from ${JSON.stringify(BUILDER)};
export const schema = defineSchema(({ table }) => ({
  authors: table("authors", { id: id(), email: text() }),
}));
`;

const onDevBranch = {
  branch: { name: DEV },
  verdict: { appkitOwned: true },
};
const onProduction = {
  branch: { name: PRODUCTION, status: { default: true } },
  verdict: { appkitOwned: false, reason: "it is the project's default branch" },
};

let catalog: ReturnType<typeof catalogResponder>;
/** `when` of the last migration the branch recorded; null: no journal table. */
let recorded: number | null;
const lastWhen = (root: string) =>
  readJournal(path.join(root, MIGRATIONS))?.entries.at(-1)?.when ?? null;
const pool = {
  query: vi.fn(async (text: string, values: unknown[]) => {
    // The branch's migration journal (pendingMigrationTags).
    if (text.includes("max(created_at)")) return { rows: [{ last: recorded }] };
    if (text.includes("c.relname = $2")) {
      return { rows: recorded === null ? [] : [{ "?column?": 1 }] };
    }
    return { rows: await catalog.respond(text, values) };
  }),
  end: vi.fn(async () => undefined),
};

beforeEach(() => {
  catalog = catalogResponder();
  recorded = null;
  checkAppkitBranch.mockReset().mockResolvedValue(onDevBranch);
  markMigrationsApplied
    .mockReset()
    .mockImplementation(
      async (_pool: unknown, options: { migrationsFolder: string }) => {
        recorded =
          readJournal(options.migrationsFolder)?.entries.at(-1)?.when ?? null;
      },
    );
  openBranchPool.mockReset().mockResolvedValue(pool);
  pool.end.mockClear();
});
afterEach(cleanupTempApps);

/** A catalog with only authors(id), plus the given authors columns. */
const authorsOnly = (...columns: ColumnRow[]) =>
  catalogResponder({
    tables: [{ name: "authors", partitioned: false }],
    columns: [
      columnRow("authors", "id", "integer", { not_null: true, identity: "d" }),
      ...columns,
    ],
    constraints: [
      {
        table_name: "authors",
        name: "authors_pkey",
        kind: "p",
        columns: ["id"],
        ref_schema: null,
        ref_table: null,
        ref_columns: [],
        on_delete: " ",
        on_update: " ",
      },
    ],
    indexes: [],
  });

/** Commit a migration of the current schema.ts; `applied`: the branch has recorded it. */
async function commitMigration(root: string, applied = true): Promise<void> {
  await generateMigrationFiles({
    folder: path.join(root, MIGRATIONS),
    schema: await loadDefaultDatabaseSchema(root),
    interactive: false,
  });
  if (applied) recorded = lastWhen(root);
}

/** Every file under config/, with its contents. */
function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full)] = fs.readFileSync(full, "utf-8");
    }
  };
  if (fs.existsSync(path.join(root, "config"))) walk(path.join(root, "config"));
  return files;
}

const ctxFor = (root: string) => fakeContext({ root });
const introspect = (root: string) =>
  runIntrospect(ctxFor(root), { interactive: false, importSource: BUILDER });

describe("runIntrospect", () => {
  test("on an AppKit branch without history: schema.ts (+ .bak), 0000_baseline recorded as applied, database.d.ts", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });

    const report = await introspect(root);

    expect(catalog.calls.every((call) => call.values[0] === "app")).toBe(true);
    expect(fs.readFileSync(path.join(root, `${SCHEMA}.bak`), "utf-8")).toBe(
      previousSchema,
    );
    const written = fs.readFileSync(path.join(root, SCHEMA), "utf-8");
    expect(written).toContain('const authors = table("authors", {');
    expect(written).toContain(
      'author_id: fk(() => authors.id).notNull().onDelete("cascade"),',
    );
    expect(report).toMatchObject({
      branch: DEV,
      schemaName: "app",
      tables: ["authors", "posts"],
      schemaFile: path.join(root, SCHEMA),
      backupFile: path.join(root, `${SCHEMA}.bak`),
      recordedApplied: true,
      migration: { tag: "0000_baseline" },
    });
    expect(report.skipped.map((skip) => skip.column)).toEqual([
      "score",
      "total",
    ]);
    expect(report.warnings).toEqual([
      expect.stringMatching(/^app\.posts\.score is NOT NULL with no default/),
      expect.stringMatching(
        /^Constraint names differ from the ones migrations use: authors_email_key \(authors_email_unique\), posts_author_id_fkey \(posts_author_id_authors_id_fk\)\./,
      ),
    ]);
    expect(report.approximated).toEqual([
      "app.authors.id: a serial key is declared as id(), an identity generated BY DEFAULT",
      "app.posts: index posts_status_idx is not declared",
    ]);
    expect(
      fs.existsSync(path.join(root, MIGRATIONS, "0000_baseline.sql")),
    ).toBe(true);
    expect(markMigrationsApplied).toHaveBeenCalledWith(
      pool,
      { migrationsFolder: path.join(root, MIGRATIONS), schemaName: "app" },
      ["0000_baseline"],
    );
    expect(fs.readFileSync(report.typesFile, "utf-8")).toContain("authors");
    expect(pool.end).toHaveBeenCalledOnce();
    // The written schema is what the plugin loads.
    await expect(loadDefaultDatabaseSchema(root)).resolves.toMatchObject({
      $schemaName: "app",
    });
  });

  test("on another branch without history: writes 0000_baseline but never records it (the deployed app adopts it)", async () => {
    checkAppkitBranch.mockResolvedValue(onProduction);
    const root = tempApp({ [SCHEMA]: previousSchema });

    const report = await introspect(root);

    expect(report.migration?.tag).toBe("0000_baseline");
    expect(report.recordedApplied).toBe(false);
    expect(report.notRecorded).toBe(
      "production is not your dev or session branch (it is the project's default branch); the deployed app adopts 0000_baseline on start when its tables already exist",
    );
    expect(markMigrationsApplied).not.toHaveBeenCalled();
  });

  test("on another branch with history: refuses before reading or writing anything", async () => {
    checkAppkitBranch.mockResolvedValue(onProduction);
    const root = tempApp({ [SCHEMA]: previousSchema });
    const schema = await loadDefaultDatabaseSchema(root);
    await generateMigrationFiles({
      folder: path.join(root, MIGRATIONS),
      schema,
      interactive: false,
    });
    const before = fs.readdirSync(path.join(root, MIGRATIONS));

    const error = await introspect(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect((error as Error).message).toMatch(
      /^Refusing to introspect production: config\/database\/migrations already has history/,
    );
    expect(openBranchPool).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, SCHEMA), "utf-8")).toBe(
      previousSchema,
    );
    expect(fs.existsSync(path.join(root, `${SCHEMA}.bak`))).toBe(false);
    expect(fs.readdirSync(path.join(root, MIGRATIONS))).toEqual(before);
  });

  test("on an AppKit branch with history: writes and records the next NNNN_introspect", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    const schema = await loadDefaultDatabaseSchema(root);
    await generateMigrationFiles({
      folder: path.join(root, MIGRATIONS),
      schema,
      interactive: false,
    });
    recorded = lastWhen(root);

    const report = await introspect(root);

    expect(report.migration?.tag).toBe("0001_introspect");
    expect(report.migration?.statements.join("\n")).toContain(
      'CREATE TABLE "app"."posts"',
    );
    expect(markMigrationsApplied).toHaveBeenCalledWith(
      pool,
      expect.anything(),
      ["0001_introspect"],
    );
  });

  test("a second run with no catalog change writes no migration and records nothing", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await introspect(root);
    markMigrationsApplied.mockClear();

    const report = await introspect(root);

    expect(report.migration).toBeNull();
    expect(report.recordedApplied).toBe(false);
    expect(markMigrationsApplied).not.toHaveBeenCalled();
  });

  test("without schema.ts it reads the app schema and creates the file", async () => {
    const root = tempApp();

    const report = await introspect(root);

    expect(catalog.calls.every((call) => call.values[0] === "app")).toBe(true);
    expect(report).toMatchObject({
      schemaName: "app",
      backupFile: null,
      tables: ["authors", "posts"],
      migration: { tag: "0000_baseline" },
      recordedApplied: true,
    });
    expect(fs.readFileSync(path.join(root, SCHEMA), "utf-8")).toMatch(
      /from schema "app"\.[^]*export const schema = defineSchema\(\(\{ table[^}]*\}\) => \{/,
    );
    expect(fs.existsSync(path.join(root, `${SCHEMA}.bak`))).toBe(false);
  });

  test("--schema-name picks another schema", async () => {
    const root = tempApp();

    const report = await runIntrospect(ctxFor(root), {
      interactive: false,
      importSource: BUILDER,
      schemaName: "sales",
    });

    expect(catalog.calls.every((call) => call.values[0] === "sales")).toBe(
      true,
    );
    expect(report.schemaName).toBe("sales");
  });

  test.each([
    ["a syntax error", "export const schema = ;\n"],
    ["a single line", "// todo\n"],
    [
      "a missing import",
      `import { defineSchema } from ${JSON.stringify(BUILDER)};\nexport const schema = defineSchema(({ table }) => ({ x: table("x", { id: id() }) }));\n`,
    ],
  ])(
    "a schema.ts with %s is never read: it goes to .bak and is replaced from the app schema",
    async (_label, broken) => {
      const root = tempApp({ [SCHEMA]: broken });

      const report = await introspect(root);

      expect(catalog.calls.every((call) => call.values[0] === "app")).toBe(
        true,
      );
      expect(report).toMatchObject({
        schemaName: "app",
        tables: ["authors", "posts"],
        backupFile: path.join(root, `${SCHEMA}.bak`),
        migration: { tag: "0000_baseline" },
      });
      expect(fs.readFileSync(path.join(root, `${SCHEMA}.bak`), "utf-8")).toBe(
        broken,
      );
      expect(fs.readFileSync(path.join(root, SCHEMA), "utf-8")).toMatch(
        /from schema "app"\.[^]*export const schema = defineSchema\(\(\{ table[^}]*\}\) => \{/,
      );
    },
  );

  test("--schema-name public is written explicitly, so the app never looks for the tables in the default app schema", async () => {
    const root = tempApp();

    const report = await runIntrospect(ctxFor(root), {
      interactive: false,
      importSource: BUILDER,
      schemaName: "public",
    });

    expect(report.schemaName).toBe("public");
    expect(fs.readFileSync(path.join(root, SCHEMA), "utf-8")).toContain(
      '{ schemaName: "public" }',
    );
    expect((await loadDefaultDatabaseSchema(root)).$schemaName).toBe("public");
  });

  test("the schema schema.ts declares does not change which schema is read", async () => {
    const root = tempApp({
      [SCHEMA]: previousSchema.replace("}));", '}), { schemaName: "sales" });'),
    });

    const report = await introspect(root);

    expect(catalog.calls.every((call) => call.values[0] === "app")).toBe(true);
    expect(report.schemaName).toBe("app");
  });

  test("an empty schema next to an existing schema.ts refuses before writing anything", async () => {
    catalog = catalogResponder({
      tables: [],
      columns: [],
      constraints: [],
      indexes: [],
    });
    const root = tempApp({ [SCHEMA]: previousSchema });

    const error = await introspect(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect((error as Error).message).toBe(
      'Schema "app" on dev-alice-3f9a2c has no tables, so introspect would replace config/database/schema.ts with an empty one. Run `appkit db introspect --schema-name <name>` to read another schema.',
    );
    expect(fs.readFileSync(path.join(root, SCHEMA), "utf-8")).toBe(
      previousSchema,
    );
    expect(fs.existsSync(path.join(root, `${SCHEMA}.bak`))).toBe(false);
    expect(fs.existsSync(path.join(root, MIGRATIONS))).toBe(false);
  });

  test("an empty schema without schema.ts still writes an empty one", async () => {
    catalog = catalogResponder({
      tables: [],
      columns: [],
      constraints: [],
      indexes: [],
    });
    const root = tempApp();

    const report = await introspect(root);

    expect(report.tables).toEqual([]);
    expect(report.migration).toBeNull();
    expect(fs.readFileSync(path.join(root, SCHEMA), "utf-8")).toContain(
      "export const schema = defineSchema(() => ({}));",
    );
  });

  test("without a configured branch it fails before writing", async () => {
    checkAppkitBranch.mockResolvedValue(null);
    const root = tempApp({ [SCHEMA]: previousSchema });

    await expect(introspect(root)).rejects.toThrow(
      /No branch configured.*appkit db init/,
    );
    expect(fs.readFileSync(path.join(root, SCHEMA), "utf-8")).toBe(
      previousSchema,
    );
  });

  test("with history, a branch that has not applied every committed migration refuses before reading the catalog", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await commitMigration(root);
    // A teammate's migration, pulled but not applied on this branch yet.
    fs.writeFileSync(
      path.join(root, SCHEMA),
      previousSchema.replace(
        "email: text() }),",
        'email: text() }),\n  tags: table("tags", { id: id() }),',
      ),
    );
    await commitMigration(root, false);
    const before = tree(root);

    const error = await introspect(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect((error as Error).message).toBe(
      'Refusing to introspect dev-alice-3f9a2c: it has not applied 0001_migration in schema "app", so the migration would undo it. Run `appkit db migrate` first.',
    );
    expect(catalog.calls).toEqual([]);
    expect(tree(root)).toEqual(before);
  });

  test("with history and no schema.ts, an empty schema refuses instead of dropping every table", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await commitMigration(root);
    fs.rmSync(path.join(root, SCHEMA));
    catalog = catalogResponder({
      tables: [],
      columns: [],
      constraints: [],
      indexes: [],
    });
    const before = tree(root);

    const error = await introspect(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect((error as Error).message).toBe(
      'Schema "app" on dev-alice-3f9a2c has no tables, so introspect would write a migration that drops every table. Run `appkit db introspect --schema-name <name>` to read another schema.',
    );
    expect(tree(root)).toEqual(before);
  });

  test("with history, a migration that drops what introspect skipped is refused and nothing changes", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await commitMigration(root);
    // email still exists, with a type schema.ts cannot declare.
    catalog = authorsOnly(columnRow("authors", "email", "numeric"));
    const before = tree(root);

    const error = await introspect(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect((error as Error).message).toBe(
      'Refusing to write a migration that drops what schema.ts cannot express (authors.email): the deployed app would run ALTER TABLE "app"."authors" DROP COLUMN "email";',
    );
    expect(tree(root)).toEqual(before);
    expect(markMigrationsApplied).not.toHaveBeenCalled();
  });

  test("with history, dropping what the branch no longer has is written, recorded and warned about", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await commitMigration(root);
    catalog = authorsOnly();

    const report = await introspect(root);

    expect(report.migration?.tag).toBe("0001_introspect");
    expect(report.migration?.statements).toEqual([
      'ALTER TABLE "app"."authors" DROP COLUMN "email";',
    ]);
    expect(report.recordedApplied).toBe(true);
    expect(report.warnings).toEqual([
      '0001_introspect drops what the branch no longer has, and the deployed app runs it on start: ALTER TABLE "app"."authors" DROP COLUMN "email";',
    ]);
  });

  test("when recording fails, schema.ts, its backup and the migrations are put back, so a rerun records", async () => {
    const root = tempApp({
      [SCHEMA]: previousSchema,
      [`${SCHEMA}.bak`]: "// an older backup\n",
    });
    const before = tree(root);
    markMigrationsApplied.mockRejectedValueOnce(new Error("lock timeout"));

    const error = await introspect(root).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      "Introspect changed nothing: lock timeout",
    );
    expect(tree(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, MIGRATIONS))).toBe(false);

    const report = await introspect(root);
    expect(report).toMatchObject({
      migration: { tag: "0000_baseline" },
      recordedApplied: true,
    });
  });

  test("a second run with the same catalog keeps the original .bak", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await introspect(root);

    const second = await introspect(root);

    expect(second.backupFile).toBeNull();
    expect(fs.readFileSync(path.join(root, `${SCHEMA}.bak`), "utf-8")).toBe(
      previousSchema,
    );
  });

  test("when every table is skipped, an existing schema.ts is kept", async () => {
    catalog = catalogResponder({
      tables: [{ name: "logs", partitioned: false }],
      columns: [columnRow("logs", "line", "text")],
      constraints: [],
      indexes: [],
    });
    const root = tempApp({ [SCHEMA]: previousSchema });
    const before = tree(root);

    const error = await introspect(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect((error as Error).message).toBe(
      'Schema "app" on dev-alice-3f9a2c has no tables introspect can write (logs: it has no primary key), so introspect would replace config/database/schema.ts with an empty one. Run `appkit db introspect --schema-name <name>` to read another schema.',
    );
    expect(tree(root)).toEqual(before);
  });

  test("a generated schema.ts that does not load is reported as a bug, and schema.ts is put back", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    const before = tree(root);

    const error = await runIntrospect(ctxFor(root), {
      interactive: false,
      importSource: path.join(root, "missing-builder.ts"),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      'Introspect changed nothing: The schema.ts introspect generated does not load. This is a bug in `appkit db introspect`; please report it with the catalog of schema "app".',
    );
    expect(tree(root)).toEqual(before);
    expect(markMigrationsApplied).not.toHaveBeenCalled();
  });
});
