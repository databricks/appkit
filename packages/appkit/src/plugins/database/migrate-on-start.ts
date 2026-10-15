import type { Pool } from "pg";

import { databaseSetupFailed } from "../../database/errors";
import {
  applyPendingMigrations,
  MigrationApplyError,
  MigrationBaselineMismatchError,
} from "../../database/migrations/apply";
import {
  MigrationFilesError,
  migrationsFolder,
} from "../../database/migrations/paths";
import type { Schema } from "../../database/schema-builder";
import { createLogger } from "../../logging/logger";

const logger = createLogger("database");

/**
 * True only inside a deployed Databricks App: not local development, and the
 * runtime has set the app's name and its service principal's credentials, as
 * Databricks Apps does for every app. `databricks apps run-local` sets the
 * name but not the credentials. Locally, `appkit db migrate` applies
 * migrations instead.
 */
export function shouldMigrateOnStart(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NODE_ENV !== "development" &&
    Boolean(env.DATABRICKS_APP_NAME) &&
    Boolean(env.DATABRICKS_CLIENT_ID) &&
    Boolean(env.DATABRICKS_CLIENT_SECRET)
  );
}

/**
 * Apply pending committed migrations from <root>/config/database/migrations as
 * the app's identity (see database/migrations/ownership.ts). No journal →
 * no-op. A failed or unadoptable migration, or a missing or unreadable
 * migration file, becomes a setup failure that names it; any other error
 * (e.g. no connection) is left to lifecycle's generic sanitizer.
 */
export async function migrateOnStart(
  pool: Pick<Pool, "connect">,
  schema: Schema,
  root: string = process.cwd(),
): Promise<void> {
  let result: Awaited<ReturnType<typeof applyPendingMigrations>>;
  try {
    result = await applyPendingMigrations(pool, {
      migrationsFolder: migrationsFolder(root),
      schemaName: schema.$schemaName,
    });
  } catch (error) {
    if (
      error instanceof MigrationApplyError ||
      error instanceof MigrationBaselineMismatchError ||
      error instanceof MigrationFilesError
    ) {
      throw databaseSetupFailed(error.message);
    }
    throw error;
  }
  if (result.adopted.length > 0) {
    logger.info(
      "Adopted %s in schema %s: its tables already existed",
      result.adopted.join(", "),
      schema.$schemaName,
    );
  }
  if (result.applied.length > 0) {
    logger.info(
      "Applied migrations %s to schema %s",
      result.applied.join(", "),
      schema.$schemaName,
    );
  }
}
