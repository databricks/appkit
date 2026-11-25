import fs from "node:fs";
import path from "node:path";

import { DEFAULT_SCHEMA_FILE } from "../../plugins/database/load-schema";
import {
  DATABASE_OPERATIONS_TYPES_FILE,
  DATABASE_TYPES_FILE,
  generateDatabaseOperations,
  loadDatabaseSchema,
  writeDatabaseTypes,
} from "../../type-generator/database";
import { ROUTES_FILE } from "../../type-generator/database/generate-operations";
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
import { forkCopyRefusal, readSchemaState } from "./schema-state";

/** Whether the checkout has a config/database/schema.ts yet. */
export function hasSchemaFile(root: string): boolean {
  return fs.existsSync(path.join(root, DEFAULT_SCHEMA_FILE));
}

const WITHOUT_SCHEMA = {
  migrate: "there is nothing to migrate",
  clean: "clean cannot tell which schema to drop",
} as const;

/** Without schema.ts, point to introspect instead of a load error. */
export function requireSchemaFile(
  root: string,
  command: keyof typeof WITHOUT_SCHEMA,
): void {
  if (hasSchemaFile(root)) return;
  throw new Error(
    `No ${DEFAULT_SCHEMA_FILE} yet, so ${WITHOUT_SCHEMA[command]}. Run \`appkit db introspect\` to write it from the branch's tables, or create it.`,
  );
}

const TYPES_DIR = "shared/appkit-types";

/** What migrate and introspect regenerate from schema.ts and server/database/routes. */
interface GeneratedTypes {
  readonly typesFile: string;
  readonly operationsTypesFile: string;
  /** The routes registry main's operation generator writes next to the routes. */
  readonly routesFile: string;
}

export function generatedTypesOf(root: string): GeneratedTypes {
  return {
    typesFile: path.join(root, TYPES_DIR, DATABASE_TYPES_FILE),
    operationsTypesFile: path.join(
      root,
      TYPES_DIR,
      DATABASE_OPERATIONS_TYPES_FILE,
    ),
    routesFile: path.join(root, ROUTES_FILE),
  };
}

/** Regenerate database.d.ts, then the operation contracts, as `appkit generate-types` does. */
export async function writeGeneratedTypes(
  root: string,
  schema: Schema,
): Promise<GeneratedTypes> {
  const generated = generatedTypesOf(root);
  await writeDatabaseTypes(schema, generated.typesFile);
  await generateDatabaseOperations({
    appRoot: root,
    outFile: generated.operationsTypesFile,
  });
  return generated;
}

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
  readonly operationsTypesFile: string;
}

export interface MigrateOptions {
  /** false: an ambiguous rename throws instead of prompting. */
  readonly interactive: boolean;
  /** false: apply the committed migrations only, without writing one from schema.ts. */
  readonly generate?: boolean;
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
 * An interrupted `appkit db introspect` leaves its migration written but not
 * recorded, and running it fails on what the branch already has.
 */
function withIntrospectRecovery(error: unknown): unknown {
  if (
    !(error instanceof MigrationApplyError) ||
    !error.failed ||
    !/^\d{4}_introspect$/.test(error.failed)
  ) {
    return error;
  }
  return new Error(
    `${error.message} If an interrupted \`appkit db introspect\` wrote ${error.failed}, the branch already has what it does: rerun \`appkit db introspect\` to record it.`,
    { cause: error },
  );
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

/** Apply pending migrations to the `.env` branch, or say why they were not. */
async function applyToEnvBranch(
  ctx: DbContext,
  folder: string,
  schema: Schema,
): Promise<ApplyOutcome> {
  const notApplied = (reason: string): ApplyOutcome => ({
    applied: [],
    notApplied: reason,
  });
  if (!readJournal(folder)) {
    return notApplied(
      "no migrations to apply — schema.ts declares no tables yet",
    );
  }
  const env = await resolveEnvBranch(ctx);
  if (!env) return notApplied(NO_ENV_BRANCH);
  if (!takesWrites(env.kind)) {
    return notApplied(
      `${notYourBranch(env)}. Migrations are applied only to branches \`appkit db init\` created for you; the deployed app applies committed migrations to its own branch. The check for tables left in public was skipped too; the deployed app runs it before it migrates`,
    );
  }
  return withBranchPool(ctx, async (pool) => {
    const refusal = forkCopyRefusal(
      env.branch.name,
      schema.$schemaName,
      await readSchemaState(pool, schema.$schemaName),
      "migrate",
    );
    if (refusal) throw new Error(`Did not apply: ${refusal}`);
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
 * database.d.ts and database-operations.d.ts, and apply pending migrations to
 * the `.env` branch (only AppKit dev/session branches). One command at a time
 * owns the checkout's history.
 */
export async function runMigrate(
  ctx: DbContext,
  options: MigrateOptions,
): Promise<MigrateReport> {
  requireSchemaFile(ctx.root, "migrate");
  return withHistoryLock(ctx.root, "migrate", (lock) =>
    migrateHolding(ctx, lock, options),
  );
}

/** runMigrate for a caller that already holds the checkout's history lock. */
export async function migrateHolding(
  ctx: DbContext,
  lock: HistoryLock,
  options: MigrateOptions,
): Promise<MigrateReport> {
  const schema = await loadDatabaseSchema(
    path.join(ctx.root, DEFAULT_SCHEMA_FILE),
    { showImportError: true },
  );
  // The types follow schema.ts and server/database/routes alone, so they are
  // current even if applying fails. Written first, so a route module that
  // fails to load stops migrate before it writes a migration.
  const { typesFile, operationsTypesFile } = await writeGeneratedTypes(
    ctx.root,
    schema,
  );

  const generated =
    options.generate === false
      ? null
      : await generateMigrationFiles(lock, {
          schema,
          interactive: options.interactive,
        });
  const warnings = migrationWarnings(generated);

  let outcome: ApplyOutcome;
  try {
    outcome = await applyToEnvBranch(ctx, lock.folder, schema);
  } catch (error) {
    if (!generated) throw withIntrospectRecovery(error);
    // Nothing ran. A kept migration would create the empty copies the refusal
    // warns about, and the next run would diff schema.ts against it.
    if (error instanceof TablesLeftInPublicError) {
      await discardMigrationFiles(lock, generated);
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
      await discardMigrationFiles(lock, generated);
      throw new Error(
        `${error.message} Removed ${file}, so the next run writes it again from ${DEFAULT_SCHEMA_FILE}. Change ${DEFAULT_SCHEMA_FILE} or the branch's data, then rerun \`appkit db migrate\`.`,
        { cause: error },
      );
    }
    throw new UnappliedMigrationError(
      ctx.root,
      generated,
      warnings,
      withIntrospectRecovery(error),
    );
  }
  return {
    generated,
    ...(warnings.breaking.length > 0 ? { breaking: warnings.breaking } : {}),
    ...(warnings.dataDependent.length > 0
      ? { dataDependent: warnings.dataDependent }
      : {}),
    ...outcome,
    typesFile,
    operationsTypesFile,
  };
}
