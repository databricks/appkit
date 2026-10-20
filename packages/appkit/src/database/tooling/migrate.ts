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
import {
  journalFile,
  migrationsFolder,
  readJournal,
} from "../migrations/paths";
import { type DbContext, NO_ENV_BRANCH, withBranchPool } from "./context";
import { notYourBranch, resolveEnvBranch, takesWrites } from "./guard";
import {
  breakingStatements,
  discardMigrationFiles,
  type GeneratedMigration,
  generateMigrationFiles,
} from "./migrations";

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

/** The journal's text before this run writes to it; null when there is none. */
function readJournalText(folder: string): string | null {
  const file = journalFile(folder);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}
export const DATABASE_TYPES_PATH = path.join(
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
  /** Why nothing was applied, when applying was skipped. */
  readonly notApplied?: string;
  readonly typesFile: string;
}

export interface MigrateOptions {
  /** false: an ambiguous rename throws instead of prompting. */
  readonly interactive: boolean;
  /** false: apply the committed migrations only, without writing one from schema.ts. */
  readonly generate?: boolean;
}

type ApplyOutcome = Pick<MigrateReport, "applied" | "adopted" | "notApplied">;

/** Why migrations must not be applied to the `.env` branch; undefined when they may. */
async function applyBlocker(ctx: DbContext): Promise<string | undefined> {
  const env = await resolveEnvBranch(ctx);
  if (!env) return NO_ENV_BRANCH;
  if (takesWrites(env.kind)) return undefined;
  return `${notYourBranch(env)}. Migrations are applied only to branches \`appkit db init\` created for you; the deployed app applies committed migrations to its own branch`;
}

/** Apply pending migrations to the `.env` branch, or say why they were not. */
async function applyToEnvBranch(
  ctx: DbContext,
  folder: string,
  schemaName: string,
): Promise<ApplyOutcome> {
  const blocker = readJournal(folder)
    ? await applyBlocker(ctx)
    : "no migrations to apply — schema.ts declares no tables yet";
  if (blocker) return { applied: [], notApplied: blocker };
  return withBranchPool(ctx, async (pool) => {
    const { applied, adopted } = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName,
    });
    return { applied, ...(adopted.length > 0 ? { adopted } : {}) };
  });
}

/**
 * `appkit db migrate`: generate a migration when schema.ts changed, regenerate
 * database.d.ts, and apply pending migrations to the `.env` branch (only AppKit
 * dev/session branches).
 */
export async function runMigrate(
  ctx: DbContext,
  options: MigrateOptions,
): Promise<MigrateReport> {
  requireSchemaFile(ctx.root, "migrate");
  const schema = await loadDefaultDatabaseSchema(ctx.root, {
    showImportError: true,
  });
  const folder = migrationsFolder(ctx.root);
  const journalBefore = readJournalText(folder);
  const generated =
    options.generate === false
      ? null
      : await generateMigrationFiles({
          folder,
          schema,
          interactive: options.interactive,
        });

  // The types follow schema.ts alone, so they are current even if applying fails.
  const typesFile = path.join(ctx.root, DATABASE_TYPES_PATH);
  await writeDatabaseTypes(schema, typesFile);

  let outcome: ApplyOutcome;
  try {
    outcome = await applyToEnvBranch(ctx, folder, schema.$schemaName);
  } catch (error) {
    if (!generated) throw error;
    const file = path.relative(ctx.root, generated.file);
    // A failed migration left in the journal runs first on every later try, so a
    // fix in schema.ts would stack behind it and never apply.
    if (
      error instanceof MigrationApplyError &&
      error.failed === generated.tag &&
      error.code
    ) {
      discardMigrationFiles(folder, generated, journalBefore);
      throw new Error(
        `${error.message} Removed ${file}, so the next run writes it again from ${DEFAULT_SCHEMA_FILE}. Change ${DEFAULT_SCHEMA_FILE} or the branch's data, then rerun \`appkit db migrate\`.`,
        { cause: error },
      );
    }
    throw new Error(
      `Wrote ${file}, but did not apply it: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const breaking = breakingStatements(generated?.statements ?? []);
  return {
    generated,
    ...(breaking.length > 0 ? { breaking } : {}),
    ...outcome,
    typesFile,
  };
}
