import fs from "node:fs";
import path from "node:path";

import { loadDefaultDatabaseSchema } from "../../../plugins/database/load-schema";
import { generateDatabaseTypes } from "../../../type-generator/database";
import {
  markMigrationsApplied,
  pendingMigrationTags,
} from "../../migrations/apply";
import {
  journalFile,
  migrationsFolder,
  readJournal,
} from "../../migrations/paths";
import { DEFAULT_SCHEMA_NAME } from "../../schema-builder/define-schema";
import { type DbContext, openBranchPool } from "../context";
import { checkAppkitBranch } from "../guard";
import { DATABASE_TYPES_PATH, SCHEMA_FILE } from "../migrate";
import {
  discardMigrationFiles,
  type GeneratedMigration,
  generateMigrationFiles,
} from "../migrations";
import { resourceId } from "../targets";
import { readCatalog } from "./catalog";
import { renderSchemaSource, type Skip } from "./render";

export interface IntrospectOptions {
  /** false: an ambiguous rename against existing history throws instead of prompting. */
  readonly interactive: boolean;
  /** Schema to read; defaults to DEFAULT_SCHEMA_NAME. The current schema.ts is never read. */
  readonly schemaName?: string;
  /** Module the written schema.ts imports the builder from. Default "@databricks/appkit/beta". */
  readonly importSource?: string;
}

export interface IntrospectReport {
  readonly branch: string;
  readonly schemaName: string;
  /** Tables written to schema.ts. */
  readonly tables: readonly string[];
  readonly schemaFile: string;
  /** Where the previous schema.ts went, when this run replaced a different one. */
  readonly backupFile: string | null;
  readonly skipped: readonly Skip[];
  readonly warnings: readonly string[];
  /** What schema.ts declares differently from the database, which keeps it as it is. */
  readonly approximated: readonly string[];
  /** 0000_baseline without history, NNNN_introspect with it; null when nothing changed. */
  readonly migration: GeneratedMigration | null;
  /** The migration was recorded as applied on the branch (AppKit branches only). */
  readonly recordedApplied: boolean;
  /** Why the migration was not recorded. */
  readonly notRecorded?: string;
  readonly typesFile: string;
}

/** Introspect would leave history the deployed migrator cannot adopt. */
export class IntrospectRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntrospectRefusedError";
  }
}

/** File contents, or null when it does not exist. */
function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function writeOrRemove(file: string, contents: string | null): void {
  if (contents === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, contents);
}

/**
 * With history, a DROP in the diff runs on deploy. Without skips it is something
 * the branch no longer has; with skips it may be something the branch still has
 * but schema.ts cannot express, so the migration is refused.
 */
function refuseDropsOfSkipped(
  statements: readonly string[],
  skipped: readonly Skip[],
): void {
  const drops = statements.filter((statement) => /\bDROP\b/i.test(statement));
  if (drops.length === 0 || skipped.length === 0) return;
  const what = skipped.map((skip) =>
    skip.column ? `${skip.table}.${skip.column}` : skip.table,
  );
  throw new IntrospectRefusedError(
    `Refusing to write a migration that drops what schema.ts cannot express (${[...new Set(what)].join(", ")}): the deployed app would run ${drops.join(" ")}`,
  );
}

/**
 * `appkit db introspect`: read the branch's app schema from pg_catalog, write
 * schema.ts (the previous file goes to schema.ts.bak), write the migration that
 * brings history up to the database, and record it as applied on AppKit
 * branches. On any other branch only a first `0000_baseline` is allowed, which
 * the deployed migrator adopts; with existing history the command refuses
 * before writing anything. A failure after schema.ts is written puts back
 * schema.ts, the backup and the migrations folder.
 */
export async function runIntrospect(
  ctx: DbContext,
  options: IntrospectOptions,
): Promise<IntrospectReport> {
  const schemaFile = path.join(ctx.root, SCHEMA_FILE);
  // Introspect replaces schema.ts, so the current file (missing, empty or broken) is never read.
  const schemaName = options.schemaName || DEFAULT_SCHEMA_NAME;
  const folder = migrationsFolder(ctx.root);
  const hasHistory = (readJournal(folder)?.entries.length ?? 0) > 0;

  const check = await checkAppkitBranch(ctx);
  if (!check) {
    throw new Error(
      "No branch configured in .env (LAKEBASE_ENDPOINT) — run `appkit db init`.",
    );
  }
  const branchId = resourceId(check.branch.name);
  const owned = check.verdict.appkitOwned;
  if (hasHistory && !owned) {
    throw new IntrospectRefusedError(
      `Refusing to introspect ${branchId}: config/database/migrations already has history, and ${branchId} is not your dev or session branch (${check.verdict.reason}). ` +
        "Only a first 0000_baseline can be adopted by the deployed app. Point .env at your dev or session branch with `appkit db init` and introspect there.",
    );
  }

  const pool = await openBranchPool(ctx);
  if (!pool) {
    throw new Error(
      "No branch configured (PGHOST, PGDATABASE, LAKEBASE_ENDPOINT) — run `appkit db init`.",
    );
  }
  try {
    if (hasHistory) {
      // The diff starts from the latest committed snapshot: a migration the
      // branch lacks would come out reversed, and run reversed on deploy.
      const pending = await pendingMigrationTags(pool, {
        migrationsFolder: folder,
        schemaName,
      });
      if (pending.length > 0) {
        throw new IntrospectRefusedError(
          `Refusing to introspect ${branchId}: it has not applied ${pending.join(", ")} in schema "${schemaName}", so the migration would undo ${pending.length === 1 ? "it" : "them"}. Run \`appkit db migrate\` first.`,
        );
      }
    }

    const tables = await readCatalog(
      async (text, values) => (await pool.query(text, [...values])).rows,
      schemaName,
    );
    const rendered = renderSchemaSource(tables, schemaName, {
      importSource: options.importSource,
    });
    // An app on another schema that forgot --schema-name must not lose its
    // schema.ts to an empty one; with history, an empty schema drops every table.
    if (
      rendered.tables.length === 0 &&
      (hasHistory || fs.existsSync(schemaFile))
    ) {
      const reasons = rendered.skipped
        .filter((skip) => !skip.column)
        .map((skip) => `${skip.table}: ${skip.reason}`);
      throw new IntrospectRefusedError(
        `Schema "${schemaName}" on ${branchId} has no tables${tables.length > 0 ? ` introspect can write (${reasons.join("; ")})` : ""}, so introspect would ${hasHistory ? "write a migration that drops every table" : `replace ${SCHEMA_FILE} with an empty one`}. Run \`appkit db introspect --schema-name <name>\` to read another schema.`,
      );
    }

    // Write schema.ts, keeping the previous file when it differs.
    const backupFile = `${schemaFile}.bak`;
    const previous = readIfExists(schemaFile);
    const previousBackup = readIfExists(backupFile);
    const backsUp = previous !== null && previous !== rendered.source;
    const journalBefore = readIfExists(journalFile(folder));
    let migration: GeneratedMigration | null = null;
    let recordedApplied = false;
    if (backsUp) fs.writeFileSync(backupFile, previous);
    fs.mkdirSync(path.dirname(schemaFile), { recursive: true });
    fs.writeFileSync(schemaFile, rendered.source);
    try {
      let schema: Awaited<ReturnType<typeof loadDefaultDatabaseSchema>>;
      try {
        schema = await loadDefaultDatabaseSchema(ctx.root, {
          showImportError: true,
        });
      } catch (error) {
        throw new Error(
          `The schema.ts introspect generated does not load. This is a bug in \`appkit db introspect\`; please report it with the catalog of schema "${schemaName}".`,
          { cause: error },
        );
      }

      migration = await generateMigrationFiles({
        folder,
        schema,
        tag: hasHistory ? "introspect" : "baseline",
        interactive: options.interactive,
        ...(hasHistory
          ? {
              beforeWrite: (statements: readonly string[]) =>
                refuseDropsOfSkipped(statements, rendered.skipped),
            }
          : {}),
      });
      if (migration && owned) {
        // The database already holds what the migration describes.
        await markMigrationsApplied(
          pool,
          { migrationsFolder: folder, schemaName },
          [migration.tag],
        );
        recordedApplied = true;
      }
    } catch (error) {
      writeOrRemove(schemaFile, previous);
      if (backsUp) writeOrRemove(backupFile, previousBackup);
      if (migration) discardMigrationFiles(folder, migration, journalBefore);
      if (error instanceof IntrospectRefusedError) throw error;
      throw new Error(
        `Introspect changed nothing: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const warnings = [...rendered.warnings];
    const drops = (migration?.statements ?? []).filter((statement) =>
      /\bDROP\b/i.test(statement),
    );
    if (migration && drops.length > 0) {
      warnings.push(
        `${migration.tag} drops what the branch no longer has, and the deployed app runs it on start: ${drops.join(" ")}`,
      );
    }
    const notRecorded =
      migration && !owned
        ? `${branchId} is not your dev or session branch (${check.verdict.reason}); the deployed app adopts ${migration.tag} on start when its tables already exist`
        : undefined;

    const typesFile = path.join(ctx.root, DATABASE_TYPES_PATH);
    await generateDatabaseTypes({ schemaFile, outFile: typesFile });
    return {
      branch: check.branch.name,
      schemaName,
      tables: rendered.tables,
      schemaFile,
      backupFile: backsUp ? backupFile : null,
      skipped: rendered.skipped,
      warnings,
      approximated: rendered.approximated,
      migration,
      recordedApplied,
      ...(notRecorded ? { notRecorded } : {}),
      typesFile,
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
