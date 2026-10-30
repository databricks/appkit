import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_SCHEMA_FILE,
  loadDefaultDatabaseSchema,
} from "../../../plugins/database/load-schema";
import { writeDatabaseTypes } from "../../../type-generator/database";
import {
  markMigrationsApplied,
  readMigrationDrift,
} from "../../migrations/apply";
import { readJournal } from "../../migrations/paths";
import { DEFAULT_SCHEMA_NAME } from "../../schema-builder/define-schema";
import { type DbContext, NO_ENV_BRANCH, withBranchPool } from "../context";
import { notYourBranch, resolveEnvBranch, takesWrites } from "../guard";
import { type HistoryLock, withHistoryLock } from "../history-lock";
import { DATABASE_TYPES_PATH } from "../migrate";
import {
  breakingStatements,
  discardMigrationFiles,
  type GeneratedMigration,
  generateMigrationFiles,
} from "../migrations";
import { resourceId } from "../targets";
import { readCatalog, readUnreadObjects } from "./catalog";
import {
  renderSchemaSource,
  type Skip,
  shown,
  type Unexpressed,
} from "./render";

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
  /** Tags recorded as applied: the migration, and any an interrupted run wrote but did not record. */
  readonly recorded: readonly string[];
  readonly typesFile: string;
}

/** Introspect would record history the branch or the deployed app contradicts. */
export class IntrospectRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntrospectRefusedError";
  }
}

/** Tags introspect writes. Pending ones match the branch when a fresh render adds nothing. */
const INTROSPECT_TAG = /^\d{4}_(introspect|baseline)$/;

/** File contents, or null when it does not exist. */
function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function writeOrRemove(file: string, contents: string | null): void {
  if (contents === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, contents);
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** The statement drizzle-kit 0.31 writes to remove it. */
function dropStatement(item: Unexpressed, schemaName: string): string {
  // drizzle-kit leaves the public schema out of the name.
  const named =
    schemaName === "public"
      ? `"${item.name}"`
      : `"${schemaName}"."${item.name}"`;
  switch (item.kind) {
    case "table":
      return `DROP TABLE ${named} CASCADE;`;
    case "column":
      return `ALTER TABLE ${named} DROP COLUMN "${item.member}";`;
    case "default":
      return `ALTER TABLE ${named} ALTER COLUMN "${item.member}" DROP DEFAULT;`;
    case "constraint":
      return `ALTER TABLE ${named} DROP CONSTRAINT "${item.member}";`;
    case "type":
      return `DROP TYPE ${named};`;
  }
}

/**
 * With history, the migration is recorded here as applied and runs on deploy.
 * A drop of what the branch still has but schema.ts cannot express would be
 * recorded falsely here, and would remove it from every deployed database.
 */
function refuseDropsOfUnexpressed(
  statements: readonly string[],
  unexpressed: readonly Unexpressed[],
  schemaName: string,
): void {
  const reasons = new Map(
    unexpressed.map((item) => [dropStatement(item, schemaName), item.reason]),
  );
  const refused = statements
    .map((statement) => statement.trim())
    .filter((statement) => reasons.has(statement));
  if (refused.length === 0) return;
  throw new IntrospectRefusedError(
    `Refusing to write a migration that drops what the branch still has but schema.ts cannot express: ${refused
      .map(
        (statement) =>
          `${shown(statement)} (${shown(reasons.get(statement) ?? "")})`,
      )
      .join(
        " ",
      )}. The deployed app would run ${refused.length === 1 ? "it" : "them"} on start.`,
  );
}

/**
 * `appkit db introspect`: read the `.env` branch's app schema from pg_catalog,
 * write schema.ts (the previous file goes to schema.ts.bak), write the
 * migration that brings history up to the database, and record it as applied.
 * Runs only on your dev or session branch, and only when the branch records
 * exactly the committed migrations. A failure puts back schema.ts, the backup,
 * database.d.ts and the migrations folder. One command at a time owns the
 * checkout's history.
 */
export async function runIntrospect(
  ctx: DbContext,
  options: IntrospectOptions,
): Promise<IntrospectReport> {
  return withHistoryLock(ctx.root, "introspect", (lock) =>
    introspectHolding(ctx, lock, options),
  );
}

async function introspectHolding(
  ctx: DbContext,
  lock: HistoryLock,
  options: IntrospectOptions,
): Promise<IntrospectReport> {
  const schemaFile = path.join(ctx.root, DEFAULT_SCHEMA_FILE);
  // Introspect replaces schema.ts, so the current file (missing, empty or broken) is never read.
  const schemaName = options.schemaName || DEFAULT_SCHEMA_NAME;
  const { folder } = lock;
  const migrationOptions = { migrationsFolder: folder, schemaName };
  const hasHistory = (readJournal(folder)?.entries.length ?? 0) > 0;

  const env = await resolveEnvBranch(ctx);
  if (!env) throw new Error(`Did not introspect: ${NO_ENV_BRANCH}.`);
  if (!takesWrites(env.kind)) {
    throw new IntrospectRefusedError(
      `Refusing to introspect: ${notYourBranch(env)}. Introspect records the migration it writes as applied, so it runs only on branches \`appkit db init\` created for you. ` +
        `Run \`appkit db init\`: it creates your dev branch from the project's default branch, and introspects it when there is no ${DEFAULT_SCHEMA_FILE}.`,
    );
  }
  const branchId = resourceId(env.branch.name);

  return withBranchPool(ctx, async (pool) => {
    // The diff starts from the latest committed snapshot, so the branch must
    // record exactly the committed migrations: one it lacks would come out
    // reversed, and one the checkout lacks would come out again.
    const drift = await readMigrationDrift(pool, migrationOptions);
    const refuse = (reason: string, advice: string) =>
      new IntrospectRefusedError(
        `Refusing to introspect ${branchId}: ${reason} in schema "${schemaName}". ${advice}`,
      );
    if (drift.unknown > 0) {
      throw refuse(
        `it records ${plural(drift.unknown, "migration")} this checkout does not have`,
        "Pull the latest config/database/migrations, then rerun.",
      );
    }
    if (drift.stranded.length > 0) {
      throw refuse(
        `it skipped ${drift.stranded.join(", ")}`,
        "Run `appkit db migrate`, which says how to fix it.",
      );
    }
    // An interrupted run leaves its migration written but not recorded.
    const unrecorded = drift.pending.every((tag) => INTROSPECT_TAG.test(tag))
      ? drift.pending
      : [];
    const notApplied = (them: string) =>
      refuse(
        `it has not applied ${drift.pending.join(", ")}`,
        `${them} Run \`appkit db migrate\` first.`,
      );
    if (drift.pending.length > unrecorded.length) {
      throw notApplied(
        `The migration would undo ${drift.pending.length === 1 ? "it" : "them"}.`,
      );
    }

    const query = async <T>(text: string, values: readonly unknown[]) =>
      (await pool.query(text, [...values])).rows as T[];
    const tables = await readCatalog(query, schemaName);
    const unread = await readUnreadObjects(query, schemaName);
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
        `Schema "${schemaName}" on ${branchId} has no tables${tables.length > 0 ? ` introspect can write (${reasons.join("; ")})` : ""}, so introspect would ${hasHistory ? "write a migration that drops every table" : `replace ${DEFAULT_SCHEMA_FILE} with an empty one`}. Pass --schema-name <name> to read another schema.`,
      );
    }

    const backupFile = `${schemaFile}.bak`;
    const typesFile = path.join(ctx.root, DATABASE_TYPES_PATH);
    const previous = readIfExists(schemaFile);
    const previousBackup = readIfExists(backupFile);
    const previousTypes = readIfExists(typesFile);
    const backsUp = previous !== null && previous !== rendered.source;
    let migration: GeneratedMigration | null = null;
    let recorded: string[] = [];
    try {
      if (backsUp) fs.writeFileSync(backupFile, previous);
      fs.mkdirSync(path.dirname(schemaFile), { recursive: true });
      fs.writeFileSync(schemaFile, rendered.source);
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

      migration = await generateMigrationFiles(lock, {
        schema,
        tag: hasHistory ? "introspect" : "baseline",
        interactive: options.interactive,
        ...(hasHistory
          ? {
              beforeWrite: (statements: readonly string[]) =>
                refuseDropsOfUnexpressed(
                  statements,
                  rendered.unexpressed,
                  schemaName,
                ),
            }
          : {}),
      });
      if (unrecorded.length > 0 && migration) {
        throw notApplied(
          `Its tables differ from what ${unrecorded.length === 1 ? "it describes" : "they describe"}.`,
        );
      }
      await writeDatabaseTypes(schema, typesFile);
      // The database already holds what the migrations describe; recording is the last step.
      recorded = [...unrecorded, ...(migration ? [migration.tag] : [])];
      if (recorded.length > 0) {
        await markMigrationsApplied(pool, migrationOptions, recorded);
      }
    } catch (error) {
      writeOrRemove(schemaFile, previous);
      if (backsUp) writeOrRemove(backupFile, previousBackup);
      writeOrRemove(typesFile, previousTypes);
      if (migration) discardMigrationFiles(lock, migration);
      if (error instanceof IntrospectRefusedError) throw error;
      throw new Error(
        `Introspect changed nothing: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const warnings = [...rendered.warnings];
    if (unread.length > 0) {
      warnings.push(
        `Not read: ${unread.map(shown).join(", ")}. schema.ts and its migrations leave ${unread.length === 1 ? "it" : "them"} out, so a database the migrations create will not have ${unread.length === 1 ? "it" : "them"}.`,
      );
    }
    const breaking = breakingStatements(migration?.statements ?? []);
    if (migration && breaking.length > 0) {
      warnings.push(
        `${migration.tag} breaks instances still running the previous release, which keep serving while the new one migrates on start: ${breaking.join(" ")}`,
      );
    }
    return {
      branch: env.branch.name,
      schemaName,
      tables: rendered.tables,
      schemaFile,
      backupFile: backsUp ? backupFile : null,
      skipped: rendered.skipped,
      warnings,
      approximated: rendered.approximated,
      migration,
      recorded,
      typesFile,
    };
  });
}
