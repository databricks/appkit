import fs from "node:fs";
import path from "node:path";

import { DEFAULT_SCHEMA_FILE } from "../../../plugins/database/load-schema";
import { loadDatabaseSchema } from "../../../type-generator/database";
import {
  editedReason,
  markMigrationsApplied,
  readMigrationDrift,
} from "../../migrations/apply";
import { readJournal } from "../../migrations/paths";
import { DEFAULT_SCHEMA_NAME } from "../../schema-builder/define-schema";
import type { Schema } from "../../schema-builder/types";
import { type DbContext, NO_ENV_BRANCH, withBranchPool } from "../context";
import { refuseSymlink, SymlinkRefusedError, writeFileAtomic } from "../files";
import { notYourBranch, resolveEnvBranch, takesWrites } from "../guard";
import { type HistoryLock, withHistoryLock } from "../history-lock";
import { generatedTypesOf, writeGeneratedTypes } from "../migrate";
import {
  breakingStatements,
  discardMigrationFiles,
  type GeneratedMigration,
  generateMigrationFiles,
  generatesPending,
  type PlannedMigration,
} from "../migrations";
import {
  FORK_COPY_TAG,
  forkCopyRefusal,
  readSchemaState,
} from "../schema-state";
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
  /** Schema to read. Default: the one schema.ts declares, else DEFAULT_SCHEMA_NAME. */
  readonly schemaName?: string;
  /** Module the written schema.ts imports the builder from. Default "@databricks/appkit/beta". */
  readonly importSource?: string;
  readonly recordAsApplied?: boolean;
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
  readonly operationsTypesFile: string;
}

/** Introspect would record history the branch or the deployed app contradicts. */
export class IntrospectRefusedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IntrospectRefusedError";
  }
}

/** Tags introspect writes. A pending one is recorded when introspect would write the same SQL now. */
const INTROSPECT_TAG = /^\d{4}_(introspect|baseline)$/;

/** File contents, or null when it does not exist. */
function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function writeOrRemove(file: string, contents: string | null): void {
  if (contents === null) fs.rmSync(file, { force: true });
  else writeFileAtomic(file, contents);
}

/** Introspect replaces `file`, so a link there would be swapped for a plain file or written through. */
function refuseSymlinkedDestination(root: string, file: string): void {
  try {
    refuseSymlink(path.join(root, file));
  } catch (error) {
    if (!(error instanceof SymlinkRefusedError)) throw error;
    throw new IntrospectRefusedError(
      `Refusing to introspect: ${file} is a symbolic link, and introspect replaces files instead of writing through links. Replace it with a regular file, then rerun.`,
      { cause: error },
    );
  }
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** How a refusal names it. */
function described(item: Unexpressed, schemaName: string): string {
  const table = `${schemaName}.${item.name}`;
  switch (item.kind) {
    case "table":
      return `table ${table}`;
    case "column":
      return `column ${table}.${item.member}`;
    case "default":
      return `the default of ${table}.${item.member}`;
    case "constraint":
      return `constraint ${item.member} of ${table}`;
    case "type":
      return `type ${table}`;
  }
}

/**
 * With history, the migration is recorded here as applied and runs on deploy.
 * A drop of what the branch still has but schema.ts cannot express would be
 * recorded falsely here, and would remove it from every deployed database.
 */
function refuseDropsOfUnexpressed(
  migration: PlannedMigration,
  unexpressed: readonly Unexpressed[],
  schemaName: string,
): void {
  const refused = unexpressed.filter((item) => migration.removes(item));
  if (refused.length === 0) return;
  throw new IntrospectRefusedError(
    `Refusing to write a migration that drops what the branch still has but schema.ts cannot express: ${refused
      .map(
        (item) =>
          `${shown(described(item, schemaName))} (${shown(item.reason)})`,
      )
      .join(
        "; ",
      )}. The deployed app would drop ${refused.length === 1 ? "it" : "them"} on start.`,
  );
}

/**
 * The schema.ts introspect replaces; null when there is none. The rewrite
 * keeps its private columns and its foreign keys, so a file that does not load
 * refuses the run before anything is read or written.
 */
async function readPreviousSchema(root: string): Promise<Schema | null> {
  if (!fs.existsSync(path.join(root, DEFAULT_SCHEMA_FILE))) return null;
  try {
    return await loadDatabaseSchema(path.join(root, DEFAULT_SCHEMA_FILE), {
      showImportError: true,
    });
  } catch (error) {
    throw new IntrospectRefusedError(
      `Refusing to introspect: ${DEFAULT_SCHEMA_FILE} does not load, so introspect cannot keep the columns it marks private. Fix it, then rerun.`,
      { cause: error },
    );
  }
}

/**
 * `appkit db introspect`: read the `.env` branch's app schema from pg_catalog
 * (the one schema.ts declares, unless `--schema-name` names another), write
 * schema.ts (the previous file goes to schema.ts.bak), write the migration
 * that brings history up to the database, and record it as applied. A column
 * the previous schema.ts marks private stays private. Runs only on your dev or
 * session branch, and only when the branch records exactly the committed
 * migrations. A failure puts back schema.ts, the backup, the generated types
 * and the migrations folder. One command at a time owns the checkout's history.
 */
export async function runIntrospect(
  ctx: DbContext,
  options: IntrospectOptions,
): Promise<IntrospectReport> {
  return withHistoryLock(ctx.root, "introspect", (lock) =>
    introspectHolding(ctx, lock, options),
  );
}

/** runIntrospect for a caller that already holds the checkout's history lock. */
export async function introspectHolding(
  ctx: DbContext,
  lock: HistoryLock,
  options: IntrospectOptions,
): Promise<IntrospectReport> {
  const schemaFile = path.join(ctx.root, DEFAULT_SCHEMA_FILE);
  refuseSymlinkedDestination(ctx.root, DEFAULT_SCHEMA_FILE);
  refuseSymlinkedDestination(ctx.root, `${DEFAULT_SCHEMA_FILE}.bak`);
  const previousSchema = await readPreviousSchema(ctx.root);
  const schemaName =
    options.schemaName || previousSchema?.$schemaName || DEFAULT_SCHEMA_NAME;
  const { folder } = lock;
  const migrationOptions = { migrationsFolder: folder, schemaName };
  const hasHistory = (readJournal(folder)?.entries.length ?? 0) > 0;

  const env = await resolveEnvBranch(ctx);
  if (!env) throw new Error(`Did not introspect: ${NO_ENV_BRANCH}.`);
  if (!takesWrites(env.kind)) {
    throw new IntrospectRefusedError(
      `Refusing to introspect: ${notYourBranch(env)}. Introspect records the migration it writes as applied, so it runs only on branches \`appkit db init\` created for you. ` +
        `Run \`appkit db init\`: it creates your dev branch from the branch the default databricks.yml target binds, else the project's default branch, and introspects it when there is no ${DEFAULT_SCHEMA_FILE}.`,
    );
  }
  const branchId = resourceId(env.branch.name);
  const recordAsApplied = options.recordAsApplied ?? true;

  return withBranchPool(ctx, async (pool) => {
    if (recordAsApplied) {
      const refusal = forkCopyRefusal(
        env.branch.name,
        schemaName,
        await readSchemaState(pool, schemaName),
        "introspect",
      );
      if (refusal) {
        throw new IntrospectRefusedError(`Refusing to introspect: ${refusal}`);
      }
    }
    // The diff starts from the latest committed snapshot, so the branch must
    // record exactly the committed migrations: one it lacks would come out
    // reversed, one the checkout lacks would come out again, and one whose
    // file changed after it ran left the branch where the snapshot is not.
    const drift = await readMigrationDrift(pool, {
      ...migrationOptions,
      ignoreHashes: [FORK_COPY_TAG],
    });
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
    if (drift.edited.length > 0) {
      throw refuse(
        editedReason(drift.edited),
        `Restore ${drift.edited.length === 1 ? "the file" : "the files"} to what the branch ran and put the change in a new migration, or rebuild the branch with \`appkit db clean\`.`,
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
      previous: previousSchema,
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
    const generatedTypes = generatedTypesOf(ctx.root);
    const previous = readIfExists(schemaFile);
    const previousBackup = readIfExists(backupFile);
    const previousTypes = Object.values(generatedTypes).map(
      (file) => [file, readIfExists(file)] as const,
    );
    const backsUp = previous !== null && previous !== rendered.source;
    let migration: GeneratedMigration | null = null;
    let recorded: string[] = [];
    try {
      if (backsUp) writeFileAtomic(backupFile, previous);
      fs.mkdirSync(path.dirname(schemaFile), { recursive: true });
      writeFileAtomic(schemaFile, rendered.source);
      let schema: Schema;
      try {
        schema = await loadDatabaseSchema(schemaFile, {
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
              beforeWrite: (planned: PlannedMigration) =>
                refuseDropsOfUnexpressed(
                  planned,
                  rendered.unexpressed,
                  schemaName,
                ),
            }
          : {}),
      });
      if (unrecorded.length > 0) {
        const one = unrecorded.length === 1;
        if (migration) {
          throw notApplied(
            `Its tables differ from what ${one ? "it describes" : "they describe"}.`,
          );
        }
        // A file someone edited after introspect wrote it may do more than its snapshot says.
        if (
          !(await generatesPending(
            folder,
            schema,
            unrecorded,
            options.interactive,
          ))
        ) {
          throw notApplied(
            `${one ? "Its" : "Their"} SQL is not what introspect would write for the branch now, so recording ${one ? "it" : "them"} without running ${one ? "it" : "them"} could skip a change.`,
          );
        }
      }
      await writeGeneratedTypes(ctx.root, schema);
      // The database already holds what the migrations describe; recording is the last step.
      recorded = recordAsApplied
        ? [...unrecorded, ...(migration ? [migration.tag] : [])]
        : [];
      if (recorded.length > 0) {
        await markMigrationsApplied(pool, migrationOptions, recorded);
      }
    } catch (error) {
      writeOrRemove(schemaFile, previous);
      if (backsUp) writeOrRemove(backupFile, previousBackup);
      for (const [file, contents] of previousTypes) {
        writeOrRemove(file, contents);
      }
      if (migration) await discardMigrationFiles(lock, migration);
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
        `${migration.tag} breaks instances still running the previous release, which keep serving while the new one migrates on start: ${breaking.map(shown).join(" ")}`,
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
      typesFile: generatedTypes.typesFile,
      operationsTypesFile: generatedTypes.operationsTypesFile,
    };
  });
}
