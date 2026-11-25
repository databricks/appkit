import fs from "node:fs";

import type { Pool } from "pg";

import {
  type DevelopmentBranchKind,
  developmentBranchKind,
} from "../../database/branch-names";
import { databaseSetupFailed } from "../../database/errors";
import {
  applyPendingMigrations,
  MigrationApplyError,
  MigrationBaselineMismatchError,
  MigrationHistoryError,
  MigrationJournalError,
} from "../../database/migrations/apply";
import {
  journalFile,
  MigrationFilesError,
  migrationsFolder,
} from "../../database/migrations/paths";
import type { Schema } from "../../database/schema-builder";
import { createLogger } from "../../logging/logger";

const logger = createLogger("database");

export type MigrateOnStartDecision =
  | {
      readonly kind: "off";
      /** A non-empty flag value other than "true", which turns nothing on. */
      readonly ignored?: string;
    }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "migrate" };

/**
 * Migrate on start only when the app opted in with APPKIT_DB_MIGRATE_ON_START=true
 * (app.yaml) and the process has the identity Databricks Apps gives a deployed
 * app with a bound database. That is DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET
 * and PGUSER set to the client id. A local start, or `databricks apps run-local`
 * with exported M2M credentials, has the developer's PGUSER from `.env` or none
 * at all, and must not migrate. An unset PGUSER skips because the Lakebase pool
 * then falls back to the client id, and a developer's process would migrate as
 * the service principal.
 */
export function decideMigrateOnStart(
  env: NodeJS.ProcessEnv = process.env,
): MigrateOnStartDecision {
  const flag = env.APPKIT_DB_MIGRATE_ON_START;
  if (flag !== "true")
    return flag ? { kind: "off", ignored: flag } : { kind: "off" };
  for (const name of ["DATABRICKS_CLIENT_ID", "DATABRICKS_CLIENT_SECRET"]) {
    if (!env[name]) return { kind: "skipped", reason: `${name} is not set.` };
  }
  if (!env.PGUSER) {
    return {
      kind: "skipped",
      reason:
        "PGUSER is not set. The deployed app gets it from its database resource.",
    };
  }
  if (env.PGUSER !== env.DATABRICKS_CLIENT_ID) {
    return {
      kind: "skipped",
      reason: `PGUSER is "${env.PGUSER}", not the app's client id in DATABRICKS_CLIENT_ID.`,
    };
  }
  return { kind: "migrate" };
}

/** The branch id in LAKEBASE_ENDPOINT (projects/<p>/branches/<b>/endpoints/<e>). */
function endpointBranch(endpoint: string | undefined): string | undefined {
  return endpoint?.match(/\/branches\/([^/]+)\//)?.[1];
}

const DEVELOPMENT_BRANCH_OWNERS: Record<DevelopmentBranchKind, string> = {
  dev: "a developer",
  session: "an agent session",
};

/**
 * Apply pending committed migrations from <root>/config/database/migrations as
 * the app's identity (see database/migrations/ownership.ts). No journal →
 * no-op. Every migration failure becomes a setup failure that names it.
 */
export async function migrateOnStart(
  pool: Pick<Pool, "connect">,
  schema: Schema,
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const folder = migrationsFolder(root);
  const branch = endpointBranch(env.LAKEBASE_ENDPOINT);
  if (!branch) {
    const value = env.LAKEBASE_ENDPOINT
      ? `LAKEBASE_ENDPOINT is ${JSON.stringify(env.LAKEBASE_ENDPOINT)}`
      : "LAKEBASE_ENDPOINT is not set";
    throw databaseSetupFailed(
      `${value}, so migrate on start cannot tell which branch it would migrate. ` +
        "Set it to the app's endpoint, projects/<project>/branches/<branch>/endpoints/<endpoint>, as its database resource does.",
    );
  }
  const kind = developmentBranchKind(branch);
  if (kind) {
    const owner = DEVELOPMENT_BRANCH_OWNERS[kind];
    throw databaseSetupFailed(
      `LAKEBASE_ENDPOINT points at branch "${branch}", whose name has the shape of ${owner} branch, and a deployed app migrates only its deploy branch. ` +
        "Bind the app to its deploy branch. If this is the deploy branch, rename it so it does not look like a dev or session branch.",
    );
  }
  if (!fs.existsSync(journalFile(folder))) {
    logger.info("No committed migrations at %s; nothing to apply", folder);
    return;
  }
  // A transaction-mode pooler hands each statement to any server session, so
  // the session-level migration lock would not exclude other instances.
  if (env.PGHOST?.includes("-pooler.")) {
    throw databaseSetupFailed(
      `PGHOST ${env.PGHOST} is a pooled endpoint, and migrations need a direct connection. Use the host without "-pooler".`,
    );
  }

  const started = Date.now();
  let result: Awaited<ReturnType<typeof applyPendingMigrations>>;
  try {
    result = await applyPendingMigrations(pool, {
      migrationsFolder: folder,
      schemaName: schema.$schemaName,
      onDrift: "refuse",
    });
  } catch (error) {
    if (
      error instanceof MigrationApplyError ||
      error instanceof MigrationBaselineMismatchError ||
      error instanceof MigrationHistoryError ||
      error instanceof MigrationJournalError ||
      error instanceof MigrationFilesError
    ) {
      throw databaseSetupFailed(error.message);
    }
    throw error;
  }
  logger.info(
    "Migrations for schema %s from %s: applied=%d adopted=%d edited=%d unknown=%d lock_wait_ms=%d duration_ms=%d",
    schema.$schemaName,
    folder,
    result.applied.length,
    result.adopted.length,
    result.edited.length,
    result.unknown,
    result.lockWaitMs,
    Date.now() - started,
  );
}
