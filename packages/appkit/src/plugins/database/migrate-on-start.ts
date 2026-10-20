import fs from "node:fs";

import type { Pool } from "pg";

import { databaseSetupFailed } from "../../database/errors";
import {
  applyPendingMigrations,
  MigrationApplyError,
  MigrationBaselineMismatchError,
  MigrationHistoryError,
} from "../../database/migrations/apply";
import {
  journalFile,
  MigrationFilesError,
  migrationsFolder,
} from "../../database/migrations/paths";
import type { Schema } from "../../database/schema-builder";
import { createLogger } from "../../logging/logger";

const logger = createLogger("database");

/** Branches `appkit db` creates for one developer or one agent session; only they migrate them. */
const DEVELOPER_BRANCH = /^(dev-[a-z0-9-]+-[0-9a-f]{6}|session-[a-z0-9-]+)$/;

/**
 * True when the app opts in with APPKIT_DB_MIGRATE_ON_START=true (app.yaml)
 * and runs with service principal credentials, as Databricks Apps sets for
 * every app. `.env` never carries the flag, so a local start does not migrate;
 * `databricks apps run-local` reads app.yaml but sets no credentials.
 */
export function shouldMigrateOnStart(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.APPKIT_DB_MIGRATE_ON_START === "true" &&
    Boolean(env.DATABRICKS_CLIENT_ID) &&
    Boolean(env.DATABRICKS_CLIENT_SECRET)
  );
}

/** The branch id in LAKEBASE_ENDPOINT (projects/<p>/branches/<b>/endpoints/<e>). */
function endpointBranch(endpoint: string | undefined): string | undefined {
  return endpoint?.match(/\/branches\/([^/]+)\//)?.[1];
}

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
  if (branch && DEVELOPER_BRANCH.test(branch)) {
    logger.warn(
      "Not migrating branch %s on start: it belongs to a developer or agent session, which migrates it with `appkit db migrate`.",
      branch,
    );
    return;
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
    });
  } catch (error) {
    if (
      error instanceof MigrationApplyError ||
      error instanceof MigrationBaselineMismatchError ||
      error instanceof MigrationHistoryError ||
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
