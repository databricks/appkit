import fs from "node:fs";
import path from "node:path";

import type { PoolClient } from "pg";

import { loadDefaultDatabaseSchema } from "../../plugins/database/load-schema";
import { findSchemaProblems } from "../../plugins/database/schema-check";
import { readMigrationDrift } from "../migrations/apply";
import {
  journalFile,
  type JournalEntry,
  MigrationFilesError,
  migrationFile,
  migrationsFolder,
  parseJournal,
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

/** The committed migrations against the snapshot of the source the active deployment runs. */
type DeployedMigrations =
  /** The snapshot has every committed migration, with the same journal entry and SQL. */
  | { readonly evidence: "verified" }
  | {
      readonly evidence: "differs";
      /** Committed migrations the snapshot does not have. */
      readonly missing: readonly string[];
      /** Committed migrations the snapshot has with another journal entry or other SQL. */
      readonly changed: readonly string[];
    }
  /** The snapshot could not be read, so whether it has them is unknown. */
  | { readonly evidence: "unavailable"; readonly reason: string };

/** `appkit db verify --deployed`: whether a target's deployed app runs on its branch with the committed migrations. */
interface DeployVerifyReport {
  readonly kind: "deploy";
  readonly target: string;
  /** The target's workspace; null when databricks.yml names none. */
  readonly host: string | null;
  readonly branch: string;
  /** The app the target deploys; null when it declares none. */
  readonly app: string | null;
  /** null only when this checkout commits no migration. */
  readonly migrations: DeployedMigrations | null;
  /** What keeps the deployed app from using the branch, each with its fix. */
  readonly problems: readonly string[];
  /** No problem, and the deployed migrations verified or none committed. */
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

/** A workspace file's bytes; throws with the reason when the export fails or has no content. */
async function exportFile(ctx: DbContext, file: string): Promise<Buffer> {
  let content: string | undefined;
  try {
    const response = await ctx.workspace().request({
      method: "GET",
      path: "/api/2.0/workspace/export",
      query: { path: file, format: "AUTO" },
    });
    ({ content } = (await response.json()) as { content?: string });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`exporting ${file} failed: ${message}`, { cause: error });
  }
  if (!content) throw new Error(`${file} exported no content`);
  return Buffer.from(content, "base64");
}

/** A committed migration's journal entry and the bytes of its SQL file. */
interface CommittedMigration {
  readonly entry: JournalEntry;
  readonly sql: Buffer;
}

function readCommitted(folder: string): CommittedMigration[] {
  return (readJournal(folder)?.entries ?? []).map((entry) => {
    const file = migrationFile(folder, entry.tag);
    if (!fs.existsSync(file)) {
      throw new MigrationFilesError(
        `Missing ${file}, listed in meta/_journal.json. Restore it from version control.`,
      );
    }
    return { entry, sql: fs.readFileSync(file) };
  });
}

/**
 * The committed migrations against the snapshot of the source the active
 * deployment runs: each needs the same journal entry (idx, when,
 * breakpoints) and byte-identical SQL there. Only that snapshot is evidence.
 * Anything verify cannot read in it makes the result unavailable, never a
 * match.
 */
async function readDeployedMigrations(
  ctx: DbContext,
  deployment: Deployment | undefined,
  committed: readonly CommittedMigration[],
): Promise<DeployedMigrations | null> {
  if (committed.length === 0) return null;
  if (!deployment) {
    return {
      evidence: "unavailable",
      reason: "the app has no active deployment",
    };
  }
  const snapshot = deployment.deployment_artifacts?.source_code_path?.replace(
    /\/+$/,
    "",
  );
  if (!snapshot) {
    return {
      evidence: "unavailable",
      reason: "its active deployment names no source snapshot",
    };
  }
  const folder = migrationsFolder(ctx.root);
  const deployedPath = (file: string) =>
    `${snapshot}/${path.relative(ctx.root, file).split(path.sep).join("/")}`;
  try {
    const journalPath = deployedPath(journalFile(folder));
    const text = (await exportFile(ctx, journalPath)).toString("utf-8");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${journalPath} is not JSON: ${message}`, {
        cause: error,
      });
    }
    const deployed = parseJournal(json, journalPath).entries;
    const compared = await Promise.all(
      committed.map(async ({ entry, sql }) => {
        const found = deployed.find((other) => other?.tag === entry.tag);
        if (!found) return "missing";
        if (
          found.idx !== entry.idx ||
          found.when !== entry.when ||
          found.breakpoints !== entry.breakpoints
        ) {
          return "changed";
        }
        const file = deployedPath(migrationFile(folder, entry.tag));
        return (await exportFile(ctx, file)).equals(sql) ? "same" : "changed";
      }),
    );
    const tags = (status: "missing" | "changed") =>
      committed
        .filter((_, index) => compared[index] === status)
        .map(({ entry }) => entry.tag);
    const missing = tags("missing");
    const changed = tags("changed");
    return missing.length === 0 && changed.length === 0
      ? { evidence: "verified" }
      : { evidence: "differs", missing, changed };
  } catch (error) {
    return {
      evidence: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Why the deployed migrations do not match the committed ones, each with its fix; empty when verified. */
function migrationsProblems(
  name: string,
  migrations: DeployedMigrations,
): string[] {
  if (migrations.evidence === "verified") return [];
  if (migrations.evidence === "unavailable") {
    return [
      `verify cannot tell whether app ${name}'s active deployment has the committed migrations: ${migrations.reason}`,
    ];
  }
  const problems: string[] = [];
  const { missing, changed } = migrations;
  if (missing.length > 0) {
    const them = missing.length === 1 ? "it" : "them";
    problems.push(
      `app ${name}'s active deployment does not have ${missing.join(", ")}, which this checkout commits: ${DEPLOY} deploys ${them}, and the app applies ${them} on start`,
    );
  }
  if (changed.length > 0) {
    const them = changed.length === 1 ? "it" : "them";
    problems.push(
      `app ${name}'s active deployment has ${changed.join(", ")} with another journal entry or other SQL than this checkout commits. A migration that ran never runs again: restore ${them} to what was deployed, and put the change in a new migration`,
    );
  }
  return problems;
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
 * principal, be running, and run a snapshot with the journal entry and SQL of
 * every committed migration.
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
  const bound = target.apps.filter((app) => app.postgres.length > 0);
  if (bound.length > 1) {
    throw new Error(
      `Target ${target.name} deploys ${bound.length} apps with a postgres resource (${bound.map((app) => app.key).join(", ")}); verify checks one app per target.`,
    );
  }
  const app =
    bound[0] ?? (target.apps.length === 1 ? target.apps[0] : undefined);
  if (app && app.postgres.length > 1) {
    throw new Error(
      `App ${app.key} in target ${target.name} has ${app.postgres.length} postgres resources (${app.postgres.map((binding) => binding.at).join(", ")}); verify checks one per app.`,
    );
  }
  const declared = app?.postgres[0];
  const branchValue = declared ? declared.branch : target.postgresBranch;
  if (!branchValue) {
    throw new Error(
      `No deploy branch: target ${target.name} in ${file} declares no app with a postgres resource.`,
    );
  }
  if (branchValue.kind === "unresolved") {
    throw new Error(
      `No deploy branch: ${declared ? `${declared.at}.branch` : "variables.postgres_branch"} in target ${target.name} is "${branchValue.written}", which this checkout's files do not resolve to a branch.`,
    );
  }
  const databaseValue = declared ? declared.database : target.postgresDatabase;
  if (databaseValue?.kind === "unresolved") {
    throw new Error(
      `No deploy database: ${declared ? `${declared.at}.database` : "variables.postgres_database"} in target ${target.name} is "${databaseValue.written}", which this checkout's files do not resolve to a database.`,
    );
  }
  const branch = branchValue.name;
  const database = databaseValue?.name ?? null;
  const committed = readCommitted(migrationsFolder(ctx.root));
  const report = (
    name: string | null,
    problems: string[],
    migrations: DeployedMigrations | null,
  ): DeployVerifyReport => ({
    kind: "deploy",
    target: target.name,
    host: target.host,
    branch,
    app: name,
    migrations,
    problems,
    ok:
      problems.length === 0 &&
      (migrations === null || migrations.evidence === "verified"),
  });
  /** A report from before verify reads the deployment; its problems say why. */
  const stopped = (name: string | null, problems: string[]) =>
    report(
      name,
      problems,
      committed.length === 0
        ? null
        : {
            evidence: "unavailable",
            reason: "verify stopped before reading the app's deployment",
          },
    );
  if (!app) {
    return stopped(null, [`target ${target.name} in ${file} declares no app`]);
  }
  if (!app.name) {
    return stopped(app.declaredName, [
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
    return stopped(name, [
      `${file} deploys to ${branch}, which does not exist`,
    ]);
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
    return stopped(name, problems);
  }

  const binding = bindingProblems(deployed, name, branch, database, file);
  problems.push(...binding, ...runningProblems(deployed, name));
  const sp = deployed.service_principal_client_id;
  const [roles, migrations] = await Promise.all([
    // Only meaningful once the app is bound to this branch.
    sp && binding.length === 0 ? api.listRoles(branch) : null,
    readDeployedMigrations(ctx, deployed.active_deployment, committed),
  ]);
  if (roles && !roles.some((role) => role.status?.postgres_role === sp)) {
    problems.push(
      `the app's service principal ${sp} has no Postgres role on ${branchId}: ${DEPLOY} creates it from the app's postgres resource`,
    );
  }
  if (migrations) problems.push(...migrationsProblems(name, migrations));
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
