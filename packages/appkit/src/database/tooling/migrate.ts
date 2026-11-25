import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_SCHEMA_FILE,
  loadDefaultDatabaseSchema,
} from "../../plugins/database/load-schema";
import {
  DATABASE_TYPES_FILE,
  writeDatabaseTypes,
} from "../../type-generator/database";
import {
  applyPendingMigrations,
  MigrationApplyError,
} from "../migrations/apply";
import { readJournal } from "../migrations/paths";
import {
  catalogSqlOf,
  detectTablesLeftInPublic,
} from "../migrations/tables-left-in-public";
import type { Schema } from "../schema-builder";
import { type DbContext, NO_ENV_BRANCH, withBranchPool } from "./context";
import { notYourBranch, resolveEnvBranch, takesWrites } from "./guard";
import { type HistoryLock, withHistoryLock } from "./history-lock";
import {
  breakingStatements,
  dataDependentStatements,
  discardMigrationFiles,
  type GeneratedMigration,
  generateMigrationFiles,
} from "./migrations";

/** Whether the checkout has a config/database/schema.ts yet. */
function hasSchemaFile(root: string): boolean {
  return fs.existsSync(path.join(root, DEFAULT_SCHEMA_FILE));
}

/** Without schema.ts, point to introspect instead of a load error. */
function requireSchemaFile(root: string): void {
  if (hasSchemaFile(root)) return;
  throw new Error(
    `No ${DEFAULT_SCHEMA_FILE} yet, so there is nothing to migrate. Run \`appkit db introspect\` to write it from the branch's tables, or create it.`,
  );
}

const DATABASE_TYPES_PATH = path.join(
  "shared/appkit-types",
  DATABASE_TYPES_FILE,
);

export interface MigrateReport {
  /** The migration written by this run; null when schema.ts matches the latest snapshot. */
  readonly generated: GeneratedMigration | null;
  /** Tags applied to the `.env` branch by this run. */
  readonly applied: readonly string[];
  /** Tags recorded without running because their tables already existed (0000_baseline). */
  readonly adopted?: readonly string[];
  /** Statements of the generated migration that break instances still running the previous release. */
  readonly breaking?: readonly string[];
  readonly dataDependent?: readonly string[];
  /** Why nothing was applied, when applying was skipped. */
  readonly notApplied?: string;
  readonly typesFile: string;
}

export interface MigrateOptions {
  /** false: an ambiguous rename throws instead of prompting. */
  readonly interactive: boolean;
}

type ApplyOutcome = Pick<MigrateReport, "applied" | "adopted" | "notApplied">;

type MigrationWarnings = Required<
  Pick<MigrateReport, "breaking" | "dataDependent">
>;

function migrationWarnings(
  generated: GeneratedMigration | null,
): MigrationWarnings {
  const statements = generated?.statements ?? [];
  return {
    breaking: breakingStatements(statements),
    dataDependent: dataDependentStatements(statements),
  };
}

class UnappliedMigrationError extends Error implements MigrationWarnings {
  readonly generated: GeneratedMigration;
  readonly breaking: readonly string[];
  readonly dataDependent: readonly string[];

  constructor(
    root: string,
    generated: GeneratedMigration,
    warnings: MigrationWarnings,
    cause: unknown,
  ) {
    super(
      `Wrote ${path.relative(root, generated.file)}, but did not apply it: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "UnappliedMigrationError";
    this.generated = generated;
    this.breaking = warnings.breaking;
    this.dataDependent = warnings.dataDependent;
  }
}

/**
 * SQLSTATEs where another session or a cancel, not the migration, made it fail:
 * lock_not_available and query_canceled. The same migration can apply later.
 */
const RETRYABLE_AS_WRITTEN: ReadonlySet<string> = new Set(["55P03", "57014"]);

/** Applying was refused before anything ran: a migration would shadow tables left in public. */
class TablesLeftInPublicError extends Error {
  constructor(reason: string) {
    super(`Did not apply: ${reason}`);
    this.name = "TablesLeftInPublicError";
  }
}

/** Why migrations must not be applied to the `.env` branch; undefined when they may. */
async function applyBlocker(ctx: DbContext): Promise<string | undefined> {
  const env = await resolveEnvBranch(ctx);
  if (!env) return NO_ENV_BRANCH;
  if (takesWrites(env.kind)) return undefined;
  return `${notYourBranch(env)}. Migrations are applied only to branches \`appkit db init\` created for you; the deployed app applies committed migrations to its own branch. The check for tables left in public was skipped too; the deployed app runs it before it migrates`;
}

/** Apply pending migrations to the `.env` branch, or say why they were not. */
async function applyToEnvBranch(
  ctx: DbContext,
  folder: string,
  schema: Schema,
): Promise<ApplyOutcome> {
  const blocker = readJournal(folder)
    ? await applyBlocker(ctx)
    : "no migrations to apply — schema.ts declares no tables yet";
  if (blocker) return { applied: [], notApplied: blocker };
  return withBranchPool(ctx, async (pool) => {
    // The deployed app refuses this case on start; refuse it here first.
    const leftInPublic = await detectTablesLeftInPublic(
      catalogSqlOf(pool),
      schema,
    );
    if (leftInPublic) throw new TablesLeftInPublicError(leftInPublic);
    const { applied, adopted } = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: schema.$schemaName,
    });
    return { applied, ...(adopted.length > 0 ? { adopted } : {}) };
  });
}

/**
 * `appkit db migrate`: generate a migration when schema.ts changed, regenerate
 * database.d.ts, and apply pending migrations to the `.env` branch (only AppKit
 * dev/session branches). One command at a time owns the checkout's history.
 */
export async function runMigrate(
  ctx: DbContext,
  options: MigrateOptions,
): Promise<MigrateReport> {
  requireSchemaFile(ctx.root);
  return withHistoryLock(ctx.root, "migrate", (lock) =>
    migrateHolding(ctx, lock, options),
  );
}

async function migrateHolding(
  ctx: DbContext,
  lock: HistoryLock,
  options: MigrateOptions,
): Promise<MigrateReport> {
  const schema = await loadDefaultDatabaseSchema(ctx.root, {
    showImportError: true,
  });
  const generated = await generateMigrationFiles(lock, {
    schema,
    interactive: options.interactive,
  });
  const warnings = migrationWarnings(generated);

  // The types follow schema.ts alone, so they are current even if applying fails.
  const typesFile = path.join(ctx.root, DATABASE_TYPES_PATH);
  await writeDatabaseTypes(schema, typesFile);

  let outcome: ApplyOutcome;
  try {
    outcome = await applyToEnvBranch(ctx, lock.folder, schema);
  } catch (error) {
    if (!generated) throw error;
    // Nothing ran. A kept migration would create the empty copies the refusal
    // warns about, and the next run would diff schema.ts against it.
    if (error instanceof TablesLeftInPublicError) {
      discardMigrationFiles(lock, generated);
      throw error;
    }
    const file = path.relative(ctx.root, generated.file);
    // A failed migration left in the journal runs first on every later try, so a
    // fix in schema.ts would stack behind it and never apply.
    if (
      error instanceof MigrationApplyError &&
      error.failed === generated.tag &&
      error.code &&
      !RETRYABLE_AS_WRITTEN.has(error.code)
    ) {
      discardMigrationFiles(lock, generated);
      throw new Error(
        `${error.message} Removed ${file}, so the next run writes it again from ${DEFAULT_SCHEMA_FILE}. Change ${DEFAULT_SCHEMA_FILE} or the branch's data, then rerun \`appkit db migrate\`.`,
        { cause: error },
      );
    }
    throw new UnappliedMigrationError(ctx.root, generated, warnings, error);
  }
  return {
    generated,
    ...(warnings.breaking.length > 0 ? { breaking: warnings.breaking } : {}),
    ...(warnings.dataDependent.length > 0
      ? { dataDependent: warnings.dataDependent }
      : {}),
    ...outcome,
    typesFile,
  };
}
