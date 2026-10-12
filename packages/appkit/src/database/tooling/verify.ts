import type { PoolClient } from "pg";

import { loadDefaultDatabaseSchema } from "../../plugins/database/load-schema";
import { findSchemaProblems } from "../../plugins/database/schema-check";
import {
  pendingMigrationTags,
  type StrandedMigration,
  strandedMigrations,
} from "../migrations/apply";
import { migrationsFolder } from "../migrations/paths";
import type { DataPath } from "../runtime";
import { type DbContext, openBranchPool } from "./context";
import { requireSchemaFile } from "./migrate";
import {
  type DeployTarget,
  parseResourceName,
  readDeployTarget,
  resourceId,
} from "./targets";

export interface VerifyOptions {
  /** Check that the deployed app is set up to use the deploy branch, instead of the `.env` branch. */
  readonly prod?: boolean;
}

/** `appkit db verify`: the `.env` branch against schema.ts and the committed migrations. */
interface LocalVerifyReport {
  readonly kind: "local";
  readonly branch: string;
  /** Declared tables or columns the branch lacks (the plugin's startup check). */
  readonly schemaProblems: readonly string[];
  /** Committed migrations the branch has not recorded yet. */
  readonly pendingMigrations: readonly string[];
  /** Committed migrations the migrator will never run on the branch. */
  readonly strandedMigrations: readonly StrandedMigration[];
  readonly ok: boolean;
}

/** `appkit db verify --prod`: whether the deployed app is set up to use the deploy branch. */
interface DeployVerifyReport {
  readonly kind: "deploy";
  readonly branch: string;
  /** The app databricks.yml deploys; null when it declares none. */
  readonly app: string | null;
  /** What keeps the deployed app from using the branch, each with its fix. */
  readonly problems: readonly string[];
  readonly ok: boolean;
}

export type VerifyReport = LocalVerifyReport | DeployVerifyReport;

const NO_BRANCH =
  "No branch configured (PGHOST, PGDATABASE, LAKEBASE_ENDPOINT) — run `appkit db init`.";
const DEPLOY = "`databricks apps deploy`";
const LOGS = "`databricks apps logs`";
/** What the app's postgres resource needs to create and own its schema. */
const POSTGRES_PERMISSION = "CAN_CONNECT_AND_CREATE";

/** DataPath.raw over one connection: each interpolation becomes a $n parameter. */
function rawOn(client: Pick<PoolClient, "query">): Pick<DataPath, "raw"> {
  return {
    async raw<T>(strings: TemplateStringsArray, ...values: unknown[]) {
      const text = strings.reduce(
        (sql, part, index) => `${sql}$${index}${part}`,
      );
      const result = await client.query(text, values);
      return result.rows as T[];
    },
  };
}

/** Read-only, as the developer, on the `.env` branch: one READ ONLY transaction, rolled back. */
async function verifyLocal(ctx: DbContext): Promise<LocalVerifyReport> {
  requireSchemaFile(ctx.root, "verify");
  const schema = await loadDefaultDatabaseSchema(ctx.root, {
    showImportError: true,
  });
  const branch = parseResourceName(ctx.env.LAKEBASE_ENDPOINT)?.branch;
  if (!branch) throw new Error(NO_BRANCH);
  const pool = await openBranchPool(ctx);
  if (!pool) throw new Error(NO_BRANCH);

  try {
    const client = await pool.connect();
    let failed: unknown;
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const options = {
        migrationsFolder: migrationsFolder(ctx.root),
        schemaName: schema.$schemaName,
      };
      const schemaProblems = await findSchemaProblems(rawOn(client), schema);
      const pendingMigrations = await pendingMigrationTags(client, options);
      const stranded = await strandedMigrations(client, options);
      await client.query("ROLLBACK");
      return {
        kind: "local",
        branch,
        schemaProblems,
        pendingMigrations,
        strandedMigrations: stranded,
        ok:
          schemaProblems.length === 0 &&
          pendingMigrations.length === 0 &&
          stranded.length === 0,
      };
    } catch (error) {
      failed = error;
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      // A connection whose transaction state is unknown is not reused.
      client.release(failed instanceof Error ? failed : undefined);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

interface DeploymentStatus {
  readonly state?: string;
  readonly message?: string;
}

/** The fields of GET /api/2.0/apps/{name} that verify reads. */
interface DeployedApp {
  readonly service_principal_client_id?: string;
  readonly resources?: ReadonlyArray<{
    readonly postgres?: {
      readonly branch?: string;
      readonly database?: string;
      readonly permission?: string;
    };
  }>;
  readonly app_status?: DeploymentStatus;
  readonly compute_status?: DeploymentStatus;
  readonly active_deployment?: { readonly status?: DeploymentStatus };
  readonly pending_deployment?: { readonly status?: DeploymentStatus };
}

/** GET /api/2.0/apps/{name}; null when the app does not exist yet. */
async function readApp(
  ctx: DbContext,
  name: string,
): Promise<DeployedApp | null> {
  try {
    return (await ctx.workspace().apiClient.request({
      path: `/api/2.0/apps/${encodeURIComponent(name)}`,
      method: "GET",
      headers: new Headers({ Accept: "application/json" }),
      raw: false,
    })) as DeployedApp;
  } catch (error) {
    if ((error as { statusCode?: unknown } | null)?.statusCode === 404) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read app ${name}: ${message}`, {
      cause: error,
    });
  }
}

/** The app's postgres resource against databricks.yml: same branch and database, and the permission to create its schema. */
function bindingProblems(
  app: DeployedApp,
  name: string,
  deploy: DeployTarget,
): string[] {
  const bound = (app.resources ?? []).flatMap((resource) =>
    resource.postgres ? [resource.postgres] : [],
  );
  const binding = bound.find((postgres) => postgres.branch === deploy.branch);
  if (!binding) {
    return [
      bound.length > 0
        ? `app ${name} uses branch ${bound.map((postgres) => postgres.branch).join(", ")}, not ${deploy.branch} from databricks.yml: ${DEPLOY} applies databricks.yml`
        : `app ${name} has no postgres resource: ${DEPLOY} adds the one databricks.yml declares`,
    ];
  }
  const problems: string[] = [];
  if (deploy.database && binding.database !== deploy.database) {
    problems.push(
      `app ${name} uses database ${binding.database ?? "(none)"}, not ${deploy.database} from databricks.yml: ${DEPLOY} applies databricks.yml`,
    );
  }
  if (binding.permission !== POSTGRES_PERMISSION) {
    problems.push(
      `app ${name}'s postgres resource has permission ${binding.permission ?? "(none)"}, but the app needs ${POSTGRES_PERMISSION} to create its schema: set it in databricks.yml, then run ${DEPLOY}`,
    );
  }
  return problems;
}

/** ": <message>" for an API status message, without its final period; "" without one. */
function detail(message: string | undefined): string {
  const text = message?.trim().replace(/\.+$/, "");
  return text ? `: ${text}` : "";
}

/** Whether the app is up: a running app has applied its migrations and checked its schema on start. */
function runningProblems(app: DeployedApp, name: string): string[] {
  const pending = app.pending_deployment?.status;
  if (pending?.state === "IN_PROGRESS") {
    return [
      `a deployment of app ${name} is in progress: run verify again when it finishes`,
    ];
  }
  const deployment = app.active_deployment?.status;
  if (pending?.state === "FAILED" || deployment?.state === "FAILED") {
    const failed = pending?.state === "FAILED" ? pending : deployment;
    return [
      `the last deployment of app ${name} failed${detail(failed?.message)}. ${LOGS} shows why`,
    ];
  }
  const compute = app.compute_status;
  // A stopped app's API response has no active_deployment, deployed before or not.
  if (compute?.state === "STOPPED") {
    return [
      `app ${name} is stopped: \`databricks apps start\` starts its last deployment, or ${DEPLOY} deploys the current code; it migrates on start`,
    ];
  }
  if (!app.active_deployment) {
    return [`app ${name} has no deployment yet: ${DEPLOY} deploys it`];
  }
  if (compute?.state && compute.state !== "ACTIVE") {
    return [
      `app ${name}'s compute is ${compute.state.toLowerCase()}${detail(compute.message)}`,
    ];
  }
  const status = app.app_status;
  if (status?.state === "RUNNING") return [];
  return [
    `app ${name} is ${status?.state?.toLowerCase() ?? "not running"}${detail(status?.message)}. ${LOGS} shows why; a migration that fails stops the app on start`,
  ];
}

/**
 * --prod, through the Databricks API only: no database connection, so no
 * Postgres role on the deploy branch is needed. The app must exist, be bound
 * to the branch and database databricks.yml names with CAN_CONNECT_AND_CREATE,
 * have a role on the branch for its service principal, and be running.
 */
async function verifyDeploy(ctx: DbContext): Promise<DeployVerifyReport> {
  const deploy = readDeployTarget(ctx.root);
  if (!deploy) {
    throw new Error(
      "No deploy branch: the default target in databricks.yml binds no postgres_branch.",
    );
  }
  const report = (
    app: string | null,
    problems: string[],
  ): DeployVerifyReport => ({
    kind: "deploy",
    branch: deploy.branch,
    app,
    problems,
    ok: problems.length === 0,
  });
  const name = deploy.appName;
  if (!name) return report(null, ["databricks.yml declares no app"]);
  if (name.includes("${")) {
    return report(name, [
      `databricks.yml names the app ${name}, with a variable verify cannot resolve`,
    ]);
  }

  const api = ctx.api();
  const [branch, database, app] = await Promise.all([
    api.getBranch(deploy.branch),
    deploy.database ? api.getDatabase(deploy.database) : null,
    readApp(ctx, name),
  ]);
  const branchId = resourceId(deploy.branch);
  if (!branch) {
    return report(name, [
      `databricks.yml deploys to ${deploy.branch}, which does not exist`,
    ]);
  }
  const problems: string[] = [];
  if (deploy.database && !database) {
    problems.push(
      `databricks.yml binds database ${deploy.database}, which does not exist on ${branchId}`,
    );
  }
  if (!app) {
    problems.push(
      `app ${name} is not deployed yet: ${DEPLOY} creates it and gives it access to ${branchId}`,
    );
    return report(name, problems);
  }

  const binding = bindingProblems(app, name, deploy);
  const running = runningProblems(app, name);
  problems.push(...binding, ...running);
  const sp = app.service_principal_client_id;
  // Only meaningful once the app is bound to this branch.
  if (sp && binding.length === 0) {
    const roles = await api.listRoles(deploy.branch);
    if (!roles.some((role) => role.status?.postgres_role === sp)) {
      problems.push(
        `the app's service principal ${sp} has no Postgres role on ${branchId}: ${DEPLOY} creates it from the app's postgres resource`,
      );
    }
  }
  return report(name, problems);
}

/**
 * `appkit db verify`: check the `.env` branch against schema.ts (the plugin's
 * startup check) and the committed migrations, read-only. With `prod`, check
 * through the Databricks API that the deployed app is set up to use the deploy
 * branch; that reads no database, so it needs no role on the deploy branch.
 * Nothing is written or created either way.
 */
export async function runVerify(
  ctx: DbContext,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  return options.prod ? verifyDeploy(ctx) : verifyLocal(ctx);
}
