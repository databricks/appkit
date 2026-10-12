import path from "node:path";

import type { PoolClient } from "pg";

import { loadDefaultDatabaseSchema } from "../../plugins/database/load-schema";
import { findSchemaProblems } from "../../plugins/database/schema-check";
import { readMigrationDrift } from "../migrations/apply";
import {
  journalFile,
  type JournalEntry,
  migrationsFolder,
  readJournal,
} from "../migrations/paths";
import type { DataPath } from "../runtime";
import { type DbContext, NO_ENV_BRANCH, withBranchPool } from "./context";
import { resolveEnvBranch, takesWrites } from "./guard";
import { requireSchemaFile } from "./migrate";
import {
  type BundleTarget,
  defaultBundleTarget,
  readBundle,
  resourceId,
} from "./targets";

export interface VerifyOptions {
  /** Check the deployed app of a databricks.yml target instead of the `.env` branch. */
  readonly deployed?: boolean;
  /** The target to check; the bundle's default target without one. */
  readonly target?: string;
}

/** `appkit db verify`: the `.env` branch against schema.ts and the committed migrations. */
interface LocalVerifyReport {
  readonly kind: "local";
  readonly branch: string;
  /** Why the branch is not your dev or session branch, e.g. "it is the project's default branch"; null when it is. */
  readonly notYours: string | null;
  /** Declared tables or columns the branch lacks (the plugin's startup check). */
  readonly schemaProblems: readonly string[];
  /** Committed migrations the branch has not run yet, newer than every one it ran. */
  readonly pendingMigrations: readonly string[];
  /** Committed migrations older than one the branch ran, never run: merged out of order. */
  readonly strandedMigrations: readonly string[];
  /** Migrations the branch ran whose committed file changed since. */
  readonly editedMigrations: readonly string[];
  /** Migrations the branch ran that this checkout does not commit, e.g. from another git branch. */
  readonly unknownMigrations: number;
  readonly ok: boolean;
}

/** How the deployed migrations compare with the committed ones. */
interface DeployedMigrations {
  /** "deployed code": the deployment's journal; "deploy time": committed after the deployment was created. */
  readonly checked: "deployed code" | "deploy time";
  /** Committed migrations the active deployment does not have. */
  readonly missing: readonly string[];
}

/** `appkit db verify --deployed`: whether a target's deployed app runs on its branch with the committed migrations. */
interface DeployVerifyReport {
  readonly kind: "deploy";
  readonly target: string;
  /** The target's workspace; null when databricks.yml names none. */
  readonly host: string | null;
  readonly branch: string;
  /** The app the target deploys; null when it declares none. */
  readonly app: string | null;
  /** null when there are no committed migrations, or no deployment to compare with. */
  readonly migrations: DeployedMigrations | null;
  /** What keeps the deployed app from using the branch, each with its fix. */
  readonly problems: readonly string[];
  readonly ok: boolean;
}

export type VerifyReport = LocalVerifyReport | DeployVerifyReport;

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
  const env = await resolveEnvBranch(ctx);
  if (!env) throw new Error(`Did not verify: ${NO_ENV_BRANCH}.`);
  const branch = env.branch.name;
  const schema = await loadDefaultDatabaseSchema(ctx.root, {
    showImportError: true,
  });
  return withBranchPool(ctx, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("begin transaction read only");
      const schemaProblems = await findSchemaProblems(rawOn(client), schema);
      const drift = await readMigrationDrift(client, {
        migrationsFolder: migrationsFolder(ctx.root),
        schemaName: schema.$schemaName,
      });
      return {
        kind: "local",
        branch,
        notYours: takesWrites(env.kind) ? null : (env.reason ?? null),
        schemaProblems,
        pendingMigrations: drift.pending,
        strandedMigrations: drift.stranded,
        editedMigrations: drift.edited,
        unknownMigrations: drift.unknown,
        ok:
          schemaProblems.length === 0 &&
          drift.pending.length === 0 &&
          drift.stranded.length === 0 &&
          drift.edited.length === 0 &&
          drift.unknown === 0,
      };
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
}

interface DeploymentStatus {
  readonly state?: string;
  readonly message?: string;
}

interface Deployment {
  readonly create_time?: string;
  /** The snapshot of the source the deployment runs. */
  readonly deployment_artifacts?: { readonly source_code_path?: string };
  readonly status?: DeploymentStatus;
}

/** The fields of GET /api/2.0/apps/{name} that verify reads, in the API's snake_case. */
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
  readonly active_deployment?: Deployment;
  readonly pending_deployment?: Deployment;
}

/** null when the app does not exist yet. */
async function readApp(
  ctx: DbContext,
  name: string,
): Promise<DeployedApp | null> {
  try {
    const response = await ctx.workspace().request({
      method: "GET",
      path: `/api/2.0/apps/${encodeURIComponent(name)}`,
    });
    return (await response.json()) as DeployedApp;
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

/** The tags in a deployed journal; null when it cannot be read, which includes a deployment without one. */
async function readDeployedTags(
  ctx: DbContext,
  file: string,
): Promise<Set<string> | null> {
  try {
    const response = await ctx.workspace().request({
      method: "GET",
      path: "/api/2.0/workspace/export",
      query: { path: file, format: "AUTO" },
    });
    const { content } = (await response.json()) as { content?: string };
    if (!content) return null;
    const journal = JSON.parse(
      Buffer.from(content, "base64").toString("utf-8"),
    );
    const entries: unknown[] = Array.isArray(journal?.entries)
      ? journal.entries
      : [];
    return new Set(
      entries
        .map((entry) => (entry as { tag?: unknown } | null)?.tag)
        .filter((tag): tag is string => typeof tag === "string"),
    );
  } catch {
    return null;
  }
}

/**
 * Committed migrations the active deployment lacks: from the journal in the
 * snapshot it runs when that is readable, else the ones generated after the
 * deployment was created.
 */
async function deployedMigrations(
  ctx: DbContext,
  deployment: Deployment | undefined,
  committed: readonly JournalEntry[],
): Promise<DeployedMigrations | null> {
  if (!deployment || committed.length === 0) return null;
  const snapshot = deployment.deployment_artifacts?.source_code_path;
  if (snapshot) {
    const relative = path
      .relative(ctx.root, journalFile(migrationsFolder(ctx.root)))
      .split(path.sep)
      .join("/");
    const deployed = await readDeployedTags(
      ctx,
      `${snapshot.replace(/\/+$/, "")}/${relative}`,
    );
    if (deployed) {
      return {
        checked: "deployed code",
        missing: committed
          .filter((entry) => !deployed.has(entry.tag))
          .map((entry) => entry.tag),
      };
    }
  }
  const created = Date.parse(deployment.create_time ?? "");
  if (Number.isNaN(created)) return null;
  return {
    checked: "deploy time",
    missing: committed
      .filter((entry) => entry.when > created)
      .map((entry) => entry.tag),
  };
}

function migrationsProblem(
  name: string,
  migrations: DeployedMigrations,
  deployment: Deployment | undefined,
): string | null {
  const { missing } = migrations;
  if (missing.length === 0) return null;
  const them = missing.length === 1 ? "it" : "them";
  const fix = `${DEPLOY} deploys ${them}, and the app applies ${them} on start`;
  return migrations.checked === "deployed code"
    ? `app ${name}'s active deployment does not have ${missing.join(", ")}, which this checkout commits: ${fix}`
    : `${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} generated after app ${name}'s active deployment (${deployment?.create_time}), so it does not have ${them}: ${fix}`;
}

/** The app's postgres resource against databricks.yml: same branch and database, and the permission to create its schema. */
function bindingProblems(
  app: DeployedApp,
  name: string,
  branch: string,
  database: string | null,
  file: string,
): string[] {
  const bound = (app.resources ?? []).flatMap((resource) =>
    resource.postgres ? [resource.postgres] : [],
  );
  const binding = bound.find((postgres) => postgres.branch === branch);
  if (!binding) {
    return [
      bound.length > 0
        ? `app ${name} uses branch ${bound.map((postgres) => postgres.branch).join(", ")}, not ${branch} from ${file}: ${DEPLOY} applies ${file}`
        : `app ${name} has no postgres resource: ${DEPLOY} adds the one ${file} declares`,
    ];
  }
  const problems: string[] = [];
  if (database && binding.database !== database) {
    problems.push(
      `app ${name} uses database ${binding.database ?? "(none)"}, not ${database} from ${file}: ${DEPLOY} applies ${file}`,
    );
  }
  if (binding.permission !== POSTGRES_PERMISSION) {
    problems.push(
      `app ${name}'s postgres resource has permission ${binding.permission ?? "(none)"}, but the app needs ${POSTGRES_PERMISSION} to create its schema: set it in ${file}, then run ${DEPLOY}`,
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

/** "a.cloud.databricks.com" for "https://A.cloud.databricks.com/". */
function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return url.toLowerCase();
  }
}

/** The API calls go to the workspace this shell is authenticated against, which must be the target's. */
async function assertTargetWorkspace(
  ctx: DbContext,
  target: BundleTarget,
): Promise<void> {
  if (!target.host) return;
  const authenticated = await ctx.workspace().getHost();
  if (hostOf(authenticated) === hostOf(target.host)) return;
  throw new Error(
    `Target ${target.name} deploys to ${target.host}, but this shell is authenticated against ${authenticated}. Set DATABRICKS_CONFIG_PROFILE to a profile for ${target.host}, then rerun.`,
  );
}

function selectTarget(
  file: string,
  targets: readonly BundleTarget[],
  name: string | undefined,
  fallback: BundleTarget | null,
): BundleTarget {
  const names = targets.map((target) => target.name).join(", ");
  if (name) {
    const target = targets.find((candidate) => candidate.name === name);
    if (!target)
      throw new Error(
        `${file} has no target ${name}; its targets are ${names}.`,
      );
    return target;
  }
  if (!fallback) {
    throw new Error(
      `${file} has no default target; pass --target with one of ${names}.`,
    );
  }
  return fallback;
}

/**
 * --deployed, through the Databricks API only: no database connection, so no
 * Postgres role on the deploy branch is needed. The target's app must exist,
 * be bound to the branch and database databricks.yml names with
 * CAN_CONNECT_AND_CREATE, have a role on the branch for its service
 * principal, be running, and run code with every committed migration.
 */
async function verifyDeploy(
  ctx: DbContext,
  targetName: string | undefined,
): Promise<DeployVerifyReport> {
  const bundle = readBundle(ctx.root);
  if (!bundle) {
    throw new Error(
      "No databricks.yml, so there is no deployed app to verify.",
    );
  }
  const { file } = bundle;
  const target = selectTarget(
    file,
    bundle.targets,
    targetName,
    defaultBundleTarget(bundle),
  );
  const bound = target.apps.filter((app) => app.postgres);
  if (bound.length > 1) {
    throw new Error(
      `Target ${target.name} deploys ${bound.length} apps with a postgres resource (${bound.map((app) => app.key).join(", ")}); verify checks one app per target.`,
    );
  }
  const app =
    bound[0] ?? (target.apps.length === 1 ? target.apps[0] : undefined);
  const branch = app?.postgres?.branch ?? target.postgresBranch;
  if (!branch) {
    throw new Error(
      app?.postgres
        ? `No deploy branch: the postgres resource of app ${app.key} in target ${target.name} names its branch with a reference only a deploy resolves.`
        : `No deploy branch: target ${target.name} in ${file} declares no app with a postgres resource.`,
    );
  }
  const database = app?.postgres?.database ?? target.postgresDatabase;
  const report = (
    name: string | null,
    problems: string[],
    migrations: DeployedMigrations | null = null,
  ): DeployVerifyReport => ({
    kind: "deploy",
    target: target.name,
    host: target.host,
    branch,
    app: name,
    migrations,
    problems,
    ok: problems.length === 0,
  });
  if (!app) {
    return report(null, [`target ${target.name} in ${file} declares no app`]);
  }
  if (!app.name) {
    return report(app.declaredName, [
      app.declaredName
        ? `${file} names the app ${app.declaredName}, with a reference verify cannot resolve`
        : `app ${app.key} in ${file} has no name`,
    ]);
  }
  const name = app.name;

  await assertTargetWorkspace(ctx, target);
  const api = ctx.api();
  const [branchFound, databaseFound, deployed] = await Promise.all([
    api.getBranch(branch),
    database ? api.getDatabase(database) : null,
    readApp(ctx, name),
  ]);
  const branchId = resourceId(branch);
  if (!branchFound) {
    return report(name, [`${file} deploys to ${branch}, which does not exist`]);
  }
  const problems: string[] = [];
  if (database && !databaseFound) {
    problems.push(
      `${file} binds database ${database}, which does not exist on ${branchId}`,
    );
  }
  if (!deployed) {
    problems.push(
      `app ${name} is not deployed yet: ${DEPLOY} creates it and gives it access to ${branchId}`,
    );
    return report(name, problems);
  }

  const binding = bindingProblems(deployed, name, branch, database, file);
  problems.push(...binding, ...runningProblems(deployed, name));
  const sp = deployed.service_principal_client_id;
  const committed = readJournal(migrationsFolder(ctx.root))?.entries ?? [];
  const [roles, migrations] = await Promise.all([
    // Only meaningful once the app is bound to this branch.
    sp && binding.length === 0 ? api.listRoles(branch) : null,
    deployedMigrations(ctx, deployed.active_deployment, committed),
  ]);
  if (roles && !roles.some((role) => role.status?.postgres_role === sp)) {
    problems.push(
      `the app's service principal ${sp} has no Postgres role on ${branchId}: ${DEPLOY} creates it from the app's postgres resource`,
    );
  }
  const missing = migrations
    ? migrationsProblem(name, migrations, deployed.active_deployment)
    : null;
  if (missing) problems.push(missing);
  return report(name, problems, migrations);
}

/**
 * `appkit db verify`: check the `.env` branch against schema.ts (the plugin's
 * startup check) and the committed migrations, read-only. With `deployed`,
 * check through the Databricks API that a target's deployed app runs on its
 * branch with the committed migrations; that reads no database, so it needs
 * no role on the deploy branch. Nothing is written or created either way.
 */
export async function runVerify(
  ctx: DbContext,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  return options.deployed
    ? verifyDeploy(ctx, options.target)
    : verifyLocal(ctx);
}
