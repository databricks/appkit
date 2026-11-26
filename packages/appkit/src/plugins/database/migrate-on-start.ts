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
import {
  catalogSqlOf,
  detectTablesLeftInPublic,
} from "../../database/migrations/tables-left-in-public";
import type { Schema } from "../../database/schema-builder";
import { createLogger } from "../../logging/logger";

const logger = createLogger("database");

export type MigrateOnStartDecision =
  | {
      readonly kind: "off";
      readonly ignoredFlagValue?: string;
    }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "migrate" };

function deployedAppIdentityGap(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ["DATABRICKS_CLIENT_ID", "DATABRICKS_CLIENT_SECRET"]) {
    if (!env[name]) return `${name} is not set.`;
  }
  if (!env.PGUSER) {
    return "PGUSER is not set. The deployed app gets it from its database resource.";
  }
  if (env.PGUSER !== env.DATABRICKS_CLIENT_ID) {
    return `PGUSER is "${env.PGUSER}", not the app's client id in DATABRICKS_CLIENT_ID.`;
  }
  return undefined;
}

export function decideMigrateOnStart(
  env: NodeJS.ProcessEnv = process.env,
): MigrateOnStartDecision {
  const flag = env.APPKIT_DB_MIGRATE_ON_START;
  if (flag !== "true")
    return flag ? { kind: "off", ignoredFlagValue: flag } : { kind: "off" };
  const gap = deployedAppIdentityGap(env);
  return gap ? { kind: "skipped", reason: gap } : { kind: "migrate" };
}

function endpointBranch(endpoint: string | undefined): string | undefined {
  return endpoint?.match(
    /^projects\/[^/]+\/branches\/([^/]+)\/endpoints\/[^/]+$/,
  )?.[1];
}

const DEVELOPMENT_BRANCH_OWNERS: Record<DevelopmentBranchKind, string> = {
  dev: "a developer",
  session: "an agent session",
};

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
      beforeApply: async (client) => {
        const leftInPublic = await detectTablesLeftInPublic(
          catalogSqlOf(client),
          schema,
        );
        if (leftInPublic) {
          throw databaseSetupFailed(`not applying migrations: ${leftInPublic}`);
        }
      },
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
    result.unknownRecordedCount,
    result.lockWaitMs,
    Date.now() - started,
  );
}
