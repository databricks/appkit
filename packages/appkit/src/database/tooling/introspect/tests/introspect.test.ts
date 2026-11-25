import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { markMigrationsApplied, resolveEnvBranch, withBranchPool, writeTypes } =
  vi.hoisted(() => ({
    markMigrationsApplied: vi.fn(),
    resolveEnvBranch: vi.fn(),
    withBranchPool: vi.fn(),
    writeTypes: vi.fn(),
  }));

vi.mock("../../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../context")>()),
  withBranchPool,
}));
vi.mock("../../guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../guard")>()),
  resolveEnvBranch,
}));
vi.mock("../../../migrations/apply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../migrations/apply")>()),
  markMigrationsApplied,
}));
vi.mock("../../../../type-generator/database", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../type-generator/database")
  >()),
  writeDatabaseTypes: writeTypes,
}));

import { loadDefaultDatabaseSchema } from "../../../../plugins/database/load-schema";
import { readJournal } from "../../../migrations/paths";
import { hashOf } from "../../../migrations/tests/fixtures";
import { withHistoryLock } from "../../history-lock";
import { generateMigrationFiles } from "../../migrations";
import { cleanupTempApps, fakeContext, tempApp } from "../../tests/fakes";
import type { ColumnRow, ConstraintRow, TableRow } from "../catalog";
import { IntrospectRefusedError, runIntrospect } from "../index";
import { BUILDER, catalogResponder, columnRow } from "./fixture";

const { writeDatabaseTypes } = await vi.importActual<
  typeof import("../../../../type-generator/database")
>("../../../../type-generator/database");

const SCHEMA = "config/database/schema.ts";
const MIGRATIONS = "config/database/migrations";
const TYPES = "shared/appkit-types/database.d.ts";
const OPERATION_TYPES = "shared/appkit-types/database-operations.d.ts";
const OPERATIONS_MODULE = path.resolve(
  import.meta.dirname,
  "../../../../plugins/database/operations.ts",
);
const ZOD_PACKAGE = path.dirname(
  createRequire(import.meta.url).resolve("zod/package.json"),
);
const DEV = "projects/p/branches/dev-alice-3f9a2c";
const PRODUCTION = "projects/p/branches/production";

const previousSchema = `import { defineSchema, id, text } from ${JSON.stringify(BUILDER)};
export const schema = defineSchema(({ table }) => ({
  authors: table("authors", { id: id(), email: text() }),
}));
`;

/** Declares both tables of the default catalog and its foreign key, with email private. */
const declaredSchema = `import { defineSchema, fk, id, text } from ${JSON.stringify(BUILDER)};
export const schema = defineSchema(({ table }) => {
  const authors = table("authors", { id: id(), email: text().private() });
  const posts = table("posts", {
    id: id(),
    author_id: fk(() => authors.id).notNull(),
  });
  return { authors, posts };
});
`;

const onDevBranch = { branch: { name: DEV }, kind: "dev" };
const onProduction = {
  branch: { name: PRODUCTION, status: { default: true } },
  kind: "default",
  reason: "it is the project's default branch",
};

let catalog: ReturnType<typeof catalogResponder>;
/** The journal rows of the branch, as drizzle-orm records them; empty: no journal table. */
let recorded: Array<{ when: number; hash: string }>;
/** The row the branch records for the last committed migration. */
const lastCommitted = (root: string) => {
  const folder = path.join(root, MIGRATIONS);
  const entry = readJournal(folder)?.entries.at(-1);
  if (!entry) throw new Error(`no migration committed under ${folder}`);
  return { when: entry.when, hash: hashOf(folder, entry.tag) };
};
const pool = {
  query: vi.fn(async (text: string, values: unknown[]) => {
    // readMigrationDrift: whether the journal table exists, then its rows.
    if (text.includes("c.relname = $2")) {
      // The app's own journal: an ordinary table its role owns.
      const journal = {
        relkind: "r",
        owner: "app-sp",
        schema_owner: "app-sp",
        current_user: "app-sp",
        row_security: false,
        trusted: true,
      };
      return { rows: recorded.length > 0 ? [journal] : [] };
    }
    if (text.includes("select hash, created_at")) {
      return {
        rows: recorded.map(({ when, hash }) => ({
          hash,
          created_at: String(when),
        })),
      };
    }
    return { rows: await catalog.respond(text, values) };
  }),
  end: vi.fn(async () => undefined),
};

beforeEach(() => {
  catalog = catalogResponder();
  recorded = [];
  resolveEnvBranch.mockReset().mockResolvedValue(onDevBranch);
  withBranchPool
    .mockReset()
    .mockImplementation(
      async (_ctx: unknown, fn: (p: typeof pool) => Promise<unknown>) => {
        try {
          return await fn(pool);
        } finally {
          await pool.end();
        }
      },
    );
  markMigrationsApplied
    .mockReset()
    .mockImplementation(
      async (
        _pool: unknown,
        options: { migrationsFolder: string },
        tags: readonly string[],
      ) => {
        const entries = readJournal(options.migrationsFolder)?.entries ?? [];
        for (const tag of tags) {
          recorded.push({
            when: entries.find((entry) => entry.tag === tag)?.when ?? 0,
            hash: hashOf(options.migrationsFolder, tag),
          });
        }
      },
    );
  writeTypes.mockReset().mockImplementation(writeDatabaseTypes);
  pool.end.mockClear();
});
afterEach(cleanupTempApps);

const authorsPkey: ConstraintRow = {
  table_name: "authors",
  name: "authors_pkey",
  kind: "p",
  columns: ["id"],
  ref_schema: null,
  ref_table: null,
  ref_columns: [],
  on_delete: " ",
  on_update: " ",
};

/** A catalog with authors(id) plus the given authors columns, and any extra tables. */
const authorsOnly = (
  columns: ColumnRow[] = [],
  extra: {
    tables: TableRow[];
    columns: ColumnRow[];
    constraints?: ConstraintRow[];
  } = {
    tables: [],
    columns: [],
  },
) =>
  catalogResponder({
    tables: [{ name: "authors", partitioned: false }, ...extra.tables],
    columns: [
      columnRow("authors", "id", "integer", { not_null: true, identity: "d" }),
      ...columns,
      ...extra.columns,
    ],
    constraints: [authorsPkey, ...(extra.constraints ?? [])],
    indexes: [],
  });

/** A schema.ts of authors and posts, whose author_id is a foreign key to authors. */
const postsOfAuthors = (schemaOption?: string) =>
  `import { defineSchema, fk, id } from ${JSON.stringify(BUILDER)};
export const schema = defineSchema(({ table }) => {
  const authors = table("authors", { id: id() });
  const posts = table("posts", { id: id(), author_id: fk(() => authors.id).notNull() });
  return { authors, posts };
}${schemaOption ? `, ${schemaOption}` : ""});
`;

/** postsOfAuthors' tables, with a foreign key the builder cannot declare: SET NULL on a NOT NULL column. */
const setNullOnNotNull = (schemaName: string) =>
  authorsOnly([], {
    tables: [{ name: "posts", partitioned: false }],
    columns: [
      columnRow("posts", "id", "integer", { not_null: true, identity: "d" }),
      columnRow("posts", "author_id", "integer", { not_null: true }),
    ],
    constraints: [
      { ...authorsPkey, table_name: "posts", name: "posts_pkey" },
      {
        ...authorsPkey,
        table_name: "posts",
        name: "posts_author_id_fkey",
        kind: "f",
        columns: ["author_id"],
        ref_schema: schemaName,
        ref_table: "authors",
        ref_columns: ["id"],
        on_delete: "n",
        on_update: "a",
      },
    ],
  });

/** Commit a migration of the current schema.ts; `applied`: the branch has recorded it. */
async function commitMigration(root: string, applied = true): Promise<void> {
  await withHistoryLock(root, "migrate", async (lock) =>
    generateMigrationFiles(lock, {
      schema: await loadDefaultDatabaseSchema(root),
      interactive: false,
    }),
  );
  if (applied) recorded.push(lastCommitted(root));
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
/** The error a run fails with; a run that succeeds fails the test. */
const rejection = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("expected introspect to fail");
    },
    (caught: unknown) => caught as Error,
  );
const refusal = (root: string) => rejection(introspect(root));

describe("runIntrospect", () => {
  test("without history: schema.ts (+ .bak), 0000_baseline recorded as applied, database.d.ts", async () => {
    const root = tempApp({ [SCHEMA]: declaredSchema });

    const report = await introspect(root);

    expect(catalog.calls.every((call) => call.values[0] === "app")).toBe(true);
    expect(fs.readFileSync(path.join(root, `${SCHEMA}.bak`), "utf-8")).toBe(
      declaredSchema,
    );
    const written = fs.readFileSync(path.join(root, SCHEMA), "utf-8");
    expect(written).toContain('const authors = table("authors", {');
    expect(written).toContain(
      'author_id: fk(() => authors.id).notNull().onDelete("cascade"),',
    );
    // What the replaced schema.ts declares keeps its .private(); the rest renders as the catalog has it.
    expect(written).toContain(
      "email: varchar(255).notNull().unique().private(),",
    );
    expect(written).toContain(
      "created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),",
    );
    expect(written).toContain("id: id(),");
    expect(report).toMatchObject({
      branch: DEV,
      schemaName: "app",
      tables: ["authors", "posts"],
      schemaFile: path.join(root, SCHEMA),
      backupFile: path.join(root, `${SCHEMA}.bak`),
      recorded: ["0000_baseline"],
      migration: { tag: "0000_baseline" },
    });
    expect(report.skipped.map((skip) => skip.column)).toEqual([
      "score",
      "total",
    ]);
    expect(report.warnings).toEqual([
      expect.stringMatching(/^app\.posts\.score is NOT NULL with no default/),
      "app.posts: index posts_status_idx is not in schema.ts, so a database the migrations create will not have it.",
      expect.stringMatching(
        /^Constraint names differ from the ones migrations use: authors_email_key \(authors_email_unique\), posts_author_id_fkey \(posts_author_id_authors_id_fk\)\./,
      ),
    ]);
    expect(report.approximated).toEqual([
      "app.authors.id: a serial key is declared as id(), an identity generated BY DEFAULT",
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

  test("regenerates database-operations.d.ts from server/database/routes", async () => {
    const root = tempApp({
      [SCHEMA]: declaredSchema,
      "server/database/routes/authors.ts": `import { z } from "zod";
        import { defineOperation } from ${JSON.stringify(OPERATIONS_MODULE)};
        export const getAuthor = defineOperation({
          name: "authors.get",
          method: "GET",
          input: z.object({ id: z.number() }),
          output: z.object({ id: z.number() }),
          authorize: () => true,
          execute: ({ input, db }) => db.authors.find(input.id),
        });`,
    });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(ZOD_PACKAGE, path.join(root, "node_modules/zod"), "dir");

    const report = await introspect(root);

    expect(report.operationsTypesFile).toBe(path.join(root, OPERATION_TYPES));
    expect(fs.readFileSync(report.operationsTypesFile, "utf-8")).toContain(
      '"authors.get"',
    );
  });

  test.each([
    ["without history", false],
    ["with history", true],
  ])(
    "on a branch that is not yours (%s): refuses before connecting and points to appkit db init",
    async (_label, history) => {
      resolveEnvBranch.mockResolvedValue(onProduction);
      const root = tempApp({ [SCHEMA]: previousSchema });
      if (history) await commitMigration(root);
      const before = tree(root);

      const error = await refusal(root);

      expect(error).toBeInstanceOf(IntrospectRefusedError);
      expect(error.message).toBe(
        "Refusing to introspect: production is not your dev or session branch (it is the project's default branch). Introspect records the migration it writes as applied, so it runs only on branches `appkit db init` created for you. " +
          "Run `appkit db init`: it creates your dev branch from the branch the default databricks.yml target binds, else the project's default branch, and introspects it when there is no config/database/schema.ts.",
      );
      expect(withBranchPool).not.toHaveBeenCalled();
      expect(tree(root)).toEqual(before);
    },
  );

  test("with history: writes and records the next NNNN_introspect", async () => {
    const root = tempApp({ [SCHEMA]: declaredSchema });
    await commitMigration(root);

    const report = await introspect(root);

    expect(report.migration?.tag).toBe("0001_introspect");
    expect(report.migration?.statements.join("\n")).toContain(
      'ALTER TABLE "app"."posts" ADD COLUMN "status"',
    );
    expect(report.recorded).toEqual(["0001_introspect"]);
    expect(markMigrationsApplied).toHaveBeenCalledWith(
      pool,
      expect.anything(),
      ["0001_introspect"],
    );
  });

  test("a second run with no catalog change writes no migration and records nothing", async () => {
    const root = tempApp({ [SCHEMA]: declaredSchema });
    await introspect(root);
    markMigrationsApplied.mockClear();

    const report = await introspect(root);

    expect(report.migration).toBeNull();
    expect(report.recorded).toEqual([]);
    expect(markMigrationsApplied).not.toHaveBeenCalled();
  });

  test("a migration an interrupted run wrote but did not record is recorded when the branch matches it", async () => {
    const root = tempApp({ [SCHEMA]: declaredSchema });
    await introspect(root);
    // The run stopped after writing 0000_baseline, before recording it.
    recorded = [];
    markMigrationsApplied.mockClear();

    const report = await introspect(root);

    expect(report.migration).toBeNull();
    expect(report.recorded).toEqual(["0000_baseline"]);
    expect(markMigrationsApplied).toHaveBeenCalledWith(
      pool,
      expect.anything(),
      ["0000_baseline"],
    );
  });

  test("an unrecorded introspect migration the branch no longer matches is refused, and nothing changes", async () => {
    const root = tempApp({ [SCHEMA]: declaredSchema });
    await introspect(root);
    recorded = [];
    catalog = authorsOnly();
    markMigrationsApplied.mockClear();
    const before = tree(root);

    const error = await refusal(root);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect(error.message).toBe(
      'Refusing to introspect dev-alice-3f9a2c: it has not applied 0000_baseline in schema "app". Its tables differ from what it describes. Run `appkit db migrate` first.',
    );
    expect(tree(root)).toEqual(before);
    expect(markMigrationsApplied).not.toHaveBeenCalled();
  });

  test("a pending introspect migration someone edited after introspect wrote it is refused, and nothing changes", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await commitMigration(root);
    // A teammate introspected their branch, then edited 0001_introspect before committing it.
    await introspect(root);
    recorded = recorded.slice(0, 1);
    fs.appendFileSync(
      path.join(root, MIGRATIONS, "0001_introspect.sql"),
      `--> statement-breakpoint\nUPDATE "app"."posts" SET "status" = 'closed';`,
    );
    markMigrationsApplied.mockClear();
    const before = tree(root);

    const error = await refusal(root);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect(error.message).toBe(
      'Refusing to introspect dev-alice-3f9a2c: it has not applied 0001_introspect in schema "app". Its SQL is not what introspect would write for the branch now, so recording it without running it could skip a change. Run `appkit db migrate` first.',
    );
    expect(tree(root)).toEqual(before);
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
      recorded: ["0000_baseline"],
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
    "a schema.ts with %s is refused before anything is read or written, since its private columns cannot be kept",
    async (_label, broken) => {
      const root = tempApp({ [SCHEMA]: broken });
      const before = tree(root);

      const error = await refusal(root);

      expect(error).toBeInstanceOf(IntrospectRefusedError);
      expect(error.message).toBe(
        "Refusing to introspect: config/database/schema.ts does not load, so introspect cannot keep the columns it marks private. Fix it, then rerun.",
      );
      expect(resolveEnvBranch).not.toHaveBeenCalled();
      expect(catalog.calls).toEqual([]);
      expect(tree(root)).toEqual(before);
      expect(markMigrationsApplied).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["schema.ts", SCHEMA, previousSchema],
    ["schema.ts.bak", `${SCHEMA}.bak`, "// an older backup\n"],
  ])(
    "a symlinked %s is refused before anything is read or written, since introspect does not write through links",
    async (_label, file, contents) => {
      catalog = authorsOnly();
      const root = tempApp({
        [SCHEMA]: previousSchema,
        "elsewhere/target.ts": contents,
      });
      const link = path.join(root, file);
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.join(root, "elsewhere/target.ts"), link);
      const before = tree(root);

      const error = await refusal(root);

      expect(error).toBeInstanceOf(IntrospectRefusedError);
      expect(error.message).toBe(
        `Refusing to introspect: config/database/${_label} is a symbolic link, and introspect replaces files instead of writing through links. Replace it with a regular file, then rerun.`,
      );
      expect(resolveEnvBranch).not.toHaveBeenCalled();
      expect(catalog.calls).toEqual([]);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(
        fs.readFileSync(path.join(root, "elsewhere/target.ts"), "utf-8"),
      ).toBe(contents);
      expect(tree(root)).toEqual(before);
      expect(markMigrationsApplied).not.toHaveBeenCalled();
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

  test("without --schema-name, the schema schema.ts declares is read", async () => {
    catalog = authorsOnly();
    const root = tempApp({
      [SCHEMA]: previousSchema.replace("}));", '}), { schemaName: "sales" });'),
    });

    const report = await introspect(root);

    expect(catalog.calls.every((call) => call.values[0] === "sales")).toBe(
      true,
    );
    expect(report.schemaName).toBe("sales");
    expect((await loadDefaultDatabaseSchema(root)).$schemaName).toBe("sales");
    expect(markMigrationsApplied).toHaveBeenCalledWith(
      pool,
      { migrationsFolder: path.join(root, MIGRATIONS), schemaName: "sales" },
      ["0000_baseline"],
    );
  });

  test("--schema-name overrides the schema schema.ts declares, which then declares nothing in it", async () => {
    const salesSchema = previousSchema
      .replace("email: text()", "email: text().private()")
      .replace("}));", '}), { schemaName: "sales" });');
    const root = tempApp({ [SCHEMA]: salesSchema });

    const report = await runIntrospect(ctxFor(root), {
      interactive: false,
      importSource: BUILDER,
      schemaName: "app",
    });

    expect(catalog.calls.every((call) => call.values[0] === "app")).toBe(true);
    expect(report.schemaName).toBe("app");
    // sales.authors.email being private says nothing about app.authors.email.
    const written = fs.readFileSync(path.join(root, SCHEMA), "utf-8");
    expect(written).toContain("email: varchar(255).notNull().unique(),");
    expect(written).toContain(
      'author_id: fk(() => authors.id).notNull().onDelete("cascade"),',
    );
    expect(fs.readFileSync(path.join(root, `${SCHEMA}.bak`), "utf-8")).toBe(
      salesSchema,
    );
    expect((await loadDefaultDatabaseSchema(root)).$schemaName).toBe("app");
  });

  test("a foreign key the replaced schema.ts does not declare renders with fk(); its .private() is kept", async () => {
    const root = tempApp({
      [SCHEMA]: `import { defineSchema, id, integer, text } from ${JSON.stringify(BUILDER)};
export const schema = defineSchema(({ table }) => ({
  authors: table("authors", { id: id(), email: text().private() }),
  posts: table("posts", { id: id(), author_id: integer().notNull() }),
}));
`,
    });
    await commitMigration(root);

    const report = await introspect(root);

    const written = fs.readFileSync(path.join(root, SCHEMA), "utf-8");
    expect(written).toContain(
      'author_id: fk(() => authors.id).notNull().onDelete("cascade"),',
    );
    expect(written).toContain(
      "email: varchar(255).notNull().unique().private(),",
    );
    expect(written).toContain(
      "created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),",
    );
    expect(report.migration?.tag).toBe("0001_introspect");
    expect(report.migration?.statements.join("\n")).toContain(
      'ALTER TABLE "app"."posts" ADD CONSTRAINT "posts_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "app"."authors"("id") ON DELETE cascade',
    );
    expect(report.recorded).toEqual(["0001_introspect"]);
    expect(
      report.warnings.filter((warning) => warning.includes("private")),
    ).toEqual([]);
  });

  test("an empty schema next to an existing schema.ts refuses before writing anything", async () => {
    catalog = catalogResponder({
      tables: [],
      columns: [],
      constraints: [],
      indexes: [],
    });
    const root = tempApp({ [SCHEMA]: previousSchema });

    const error = await refusal(root);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect(error.message).toBe(
      'Schema "app" on dev-alice-3f9a2c has no tables, so introspect would replace config/database/schema.ts with an empty one. Pass --schema-name <name> to read another schema.',
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
    expect(report.recorded).toEqual([]);
    expect(fs.readFileSync(path.join(root, SCHEMA), "utf-8")).toContain(
      "export const schema = defineSchema(() => ({}));",
    );
  });

  test("without a configured branch it fails before writing", async () => {
    resolveEnvBranch.mockResolvedValue(null);
    const root = tempApp({ [SCHEMA]: previousSchema });

    await expect(introspect(root)).rejects.toThrow(
      "Did not introspect: no branch is configured in .env (PGHOST, PGDATABASE and LAKEBASE_ENDPOINT); run `appkit db init`.",
    );
    expect(fs.readFileSync(path.join(root, SCHEMA), "utf-8")).toBe(
      previousSchema,
    );
  });

  test("while another appkit db command changes the migration history, it refuses before reading the catalog", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    const before = tree(root);

    const error = await withHistoryLock(root, "migrate", () => refusal(root));

    expect(error.message).toMatch(
      /^Another `appkit db migrate` \(pid \d+ on .+\) is changing the migration history in config\/database\. /,
    );
    expect(catalog.calls).toEqual([]);
    expect(tree(root)).toEqual(before);
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

    const error = await refusal(root);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect(error.message).toBe(
      'Refusing to introspect dev-alice-3f9a2c: it has not applied 0001_migration in schema "app". The migration would undo it. Run `appkit db migrate` first.',
    );
    expect(catalog.calls).toEqual([]);
    expect(tree(root)).toEqual(before);
  });

  test.each([
    ["without history", false],
    ["with history", true],
  ])(
    "a branch that records a migration the checkout lacks (%s) is refused before reading the catalog",
    async (_label, history) => {
      const root = tempApp({ [SCHEMA]: previousSchema });
      if (history) await commitMigration(root);
      recorded.push({ when: Date.now() + 60_000, hash: "teammate" });
      const before = tree(root);

      const error = await refusal(root);

      expect(error).toBeInstanceOf(IntrospectRefusedError);
      expect(error.message).toBe(
        'Refusing to introspect dev-alice-3f9a2c: it records 1 migration this checkout does not have in schema "app". Pull the latest config/database/migrations, then rerun.',
      );
      expect(catalog.calls).toEqual([]);
      expect(tree(root)).toEqual(before);
    },
  );

  test("a branch that skipped a committed migration is refused", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await commitMigration(root, false);
    fs.writeFileSync(
      path.join(root, SCHEMA),
      previousSchema.replace("email: text() }", "email: text(), bio: text() }"),
    );
    await commitMigration(root);

    const error = await refusal(root);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect(error.message).toBe(
      'Refusing to introspect dev-alice-3f9a2c: it skipped 0000_migration in schema "app". Run `appkit db migrate`, which says how to fix it.',
    );
  });

  test("a recorded migration whose committed file changed since is refused before reading the catalog", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await commitMigration(root);
    fs.appendFileSync(
      path.join(root, MIGRATIONS, "0000_migration.sql"),
      '\n--> statement-breakpoint\nALTER TABLE "app"."authors" ADD COLUMN "bio" text;',
    );
    const before = tree(root);

    const error = await refusal(root);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect(error.message).toBe(
      'Refusing to introspect dev-alice-3f9a2c: it applied 0000_migration before its file changed in schema "app". Restore the file to what the branch ran and put the change in a new migration, or recreate the branch.',
    );
    expect(catalog.calls).toEqual([]);
    expect(tree(root)).toEqual(before);
    expect(markMigrationsApplied).not.toHaveBeenCalled();
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

    const error = await refusal(root);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect(error.message).toBe(
      'Schema "app" on dev-alice-3f9a2c has no tables, so introspect would write a migration that drops every table. Pass --schema-name <name> to read another schema.',
    );
    expect(tree(root)).toEqual(before);
  });

  test.each([
    [
      "a column it cannot declare",
      previousSchema,
      authorsOnly([columnRow("authors", "email", "numeric")]),
      'column app.authors.email (type "numeric" is not supported)',
    ],
    [
      "a default it cannot declare",
      previousSchema.replace("email: text()", 'email: text().default("x")'),
      authorsOnly([
        columnRow("authors", "email", "text", { default_expr: "lower('X')" }),
      ]),
      "the default of app.authors.email (default lower('X') is not supported)",
    ],
    [
      "a table it cannot key",
      previousSchema.replace(
        "email: text() }),",
        'email: text() }),\n  tags: table("tags", { id: id() }),',
      ),
      authorsOnly([columnRow("authors", "email", "text")], {
        tables: [{ name: "tags", partitioned: false }],
        columns: [columnRow("tags", "id", "integer", { not_null: true })],
      }),
      "table app.tags (it has no primary key)",
    ],
    [
      "a column in the public schema",
      previousSchema.replace("}));", '}), { schemaName: "public" });'),
      authorsOnly([columnRow("authors", "email", "numeric")]),
      'column public.authors.email (type "numeric" is not supported)',
    ],
    [
      "an enum type in the public schema",
      `import { defineSchema, id } from ${JSON.stringify(BUILDER)};
export const schema = defineSchema(
  ({ table, enum: enumType }) => ({
    authors: table("authors", { id: id(), mood: enumType("mood", ["a", "b"]) }),
  }),
  { schemaName: "public" },
);
`,
      // Only a table introspect cannot key still uses the type.
      authorsOnly([], {
        tables: [{ name: "events", partitioned: false }],
        columns: [
          columnRow("events", "kind", "mood", {
            type_kind: "e",
            type_schema: "public",
            type_name: "mood",
            enum_values: ["a", "b"],
          }),
        ],
      }),
      "type public.mood (only what schema.ts leaves out uses it)",
    ],
    [
      "a foreign key it cannot declare",
      postsOfAuthors(),
      setNullOnNotNull("app"),
      "constraint posts_author_id_authors_id_fk of app.posts (foreign key to authors(id) is not kept: SET NULL on a NOT NULL column)",
    ],
    [
      "a foreign key in the public schema",
      postsOfAuthors('{ schemaName: "public" }'),
      setNullOnNotNull("public"),
      "constraint posts_author_id_authors_id_fk of public.posts (foreign key to authors(id) is not kept: SET NULL on a NOT NULL column)",
    ],
  ])(
    "with history, a migration that drops %s the branch still has is refused and nothing changes",
    async (_label, committed, branch, refused) => {
      const root = tempApp({ [SCHEMA]: committed });
      await commitMigration(root);
      catalog = branch;
      const before = tree(root);

      const error = await rejection(
        runIntrospect(ctxFor(root), {
          interactive: false,
          importSource: BUILDER,
          schemaName: (await loadDefaultDatabaseSchema(root)).$schemaName,
        }),
      );

      expect(error).toBeInstanceOf(IntrospectRefusedError);
      expect(error.message).toBe(
        `Refusing to write a migration that drops what the branch still has but schema.ts cannot express: ${refused}. The deployed app would drop it on start.`,
      );
      expect(tree(root)).toEqual(before);
      expect(markMigrationsApplied).not.toHaveBeenCalled();
    },
  );

  test("with history, a skip elsewhere does not block dropping what the branch no longer has, which is recorded and warned about", async () => {
    const root = tempApp({ [SCHEMA]: previousSchema });
    await commitMigration(root);
    catalog = authorsOnly([], {
      tables: [{ name: "events", partitioned: false }],
      columns: [columnRow("events", "line", "text")],
    });

    const report = await introspect(root);

    expect(report.skipped).toEqual([
      { table: "events", reason: "it has no primary key" },
    ]);
    expect(report.migration?.tag).toBe("0001_introspect");
    expect(report.migration?.statements).toEqual([
      'ALTER TABLE "app"."authors" DROP COLUMN "email";',
    ]);
    expect(report.recorded).toEqual(["0001_introspect"]);
    expect(report.warnings).toEqual([
      '0001_introspect breaks instances still running the previous release, which keep serving while the new one migrates on start: ALTER TABLE "app"."authors" DROP COLUMN "email";',
    ]);
  });

  test("the warning about statements that break the previous release escapes catalog names", async () => {
    const root = tempApp({
      [SCHEMA]: previousSchema.replace("email: text()", '"e\\u2028x": text()'),
    });
    await commitMigration(root);
    catalog = authorsOnly();

    const report = await introspect(root);

    expect(report.warnings).toEqual([
      '0001_introspect breaks instances still running the previous release, which keep serving while the new one migrates on start: ALTER TABLE "app"."authors" DROP COLUMN "e\\u2028x";',
    ]);
  });

  test("objects introspect does not read are named in a warning", async () => {
    catalog = catalogResponder(undefined, [
      "trigger audit on authors",
      "view active_authors",
    ]);
    const root = tempApp();

    const report = await introspect(root);

    expect(report.warnings.at(-1)).toBe(
      "Not read: trigger audit on authors, view active_authors. schema.ts and its migrations leave them out, so a database the migrations create will not have them.",
    );
  });

  test.each([
    [
      "recording",
      () =>
        markMigrationsApplied.mockRejectedValueOnce(new Error("lock timeout")),
      "lock timeout",
    ],
    [
      "writing database.d.ts",
      () => writeTypes.mockRejectedValueOnce(new Error("disk full")),
      "disk full",
    ],
  ])(
    "when %s fails, schema.ts, its backup, the generated types and the migrations are put back, so a rerun records",
    async (_label, failOnce, message) => {
      const root = tempApp({
        [SCHEMA]: declaredSchema,
        [`${SCHEMA}.bak`]: "// an older backup\n",
      });
      const before = tree(root);
      failOnce();

      const error = await refusal(root);

      expect(error.message).toBe(`Introspect changed nothing: ${message}`);
      expect(tree(root)).toEqual(before);
      expect(fs.existsSync(path.join(root, MIGRATIONS))).toBe(false);
      expect(fs.existsSync(path.join(root, TYPES))).toBe(false);
      expect(fs.existsSync(path.join(root, OPERATION_TYPES))).toBe(false);
      expect(recorded).toEqual([]);

      const report = await introspect(root);
      expect(report).toMatchObject({
        migration: { tag: "0000_baseline" },
        recorded: ["0000_baseline"],
      });
    },
  );

  test("a second run with the same catalog keeps the original .bak", async () => {
    const root = tempApp({ [SCHEMA]: declaredSchema });
    await introspect(root);

    const second = await introspect(root);

    expect(second.backupFile).toBeNull();
    expect(fs.readFileSync(path.join(root, `${SCHEMA}.bak`), "utf-8")).toBe(
      declaredSchema,
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

    const error = await refusal(root);

    expect(error).toBeInstanceOf(IntrospectRefusedError);
    expect(error.message).toBe(
      'Schema "app" on dev-alice-3f9a2c has no tables introspect can write (logs: it has no primary key), so introspect would replace config/database/schema.ts with an empty one. Pass --schema-name <name> to read another schema.',
    );
    expect(tree(root)).toEqual(before);
  });

  test("a generated schema.ts that does not load is reported as a bug, and schema.ts is put back", async () => {
    const root = tempApp({ [SCHEMA]: declaredSchema });
    const before = tree(root);

    const error = await rejection(
      runIntrospect(ctxFor(root), {
        interactive: false,
        importSource: path.join(root, "missing-builder.ts"),
      }),
    );

    expect(error.message).toBe(
      'Introspect changed nothing: The schema.ts introspect generated does not load. This is a bug in `appkit db introspect`; please report it with the catalog of schema "app".',
    );
    expect(tree(root)).toEqual(before);
    expect(markMigrationsApplied).not.toHaveBeenCalled();
  });
});
