import fs from "node:fs";
import path from "node:path";

import type { PoolClient } from "pg";

import { DEFAULT_SCHEMA_FILE } from "../../plugins/database/load-schema";
import { diagnoseSchema } from "../../plugins/database/schema-check";
import { loadDatabaseSchema } from "../../type-generator/database";
import { readMigrationDriftUnlocked } from "../migrations/apply";
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
import {
  type DbContext,
  NO_ENV_BRANCH,
  profileHost,
  withBranchPool,
} from "./context";
import { everyBranchRefusal, resolveEnvBranch, takesWrites } from "./guard";
import { shown } from "./introspect/render";
import { requireSchemaFile } from "./migrate";
import {
  FORK_COPY_TAG,
  forkCopyRefusal,
  readSchemaState,
} from "./schema-state";
import {
  type BundleApp,
  type BundleTarget,
  defaultBundleTarget,
  readBundle,
  resourceId,
} from "./targets";

export interface VerifyOptions {
  readonly deployed?: boolean;
  readonly target?: string;
}

interface LocalVerifyReport {
  readonly kind: "local";
  readonly branch: string;
  readonly notYours: string | null;
  readonly refusesEveryBranch: string | null;
  readonly schemaProblems: readonly string[];
  readonly tablesInPublicAdvice: string | null;
  readonly pendingMigrations: readonly string[];
  readonly strandedMigrations: readonly string[];
  readonly editedMigrations: readonly string[];
  readonly unknownMigrations: number;
  readonly forkCopy: string | null;
  readonly ok: boolean;
}

type DeployedMigrations =
  | { readonly evidence: "verified" }
  | {
      readonly evidence: "differs";
      readonly missing: readonly string[];
      readonly changed: readonly string[];
      readonly lineEndings: readonly string[];
      readonly unknown: readonly string[];
    }
  | { readonly evidence: "unavailable"; readonly reason: string };

interface DeployVerifyReport {
  readonly kind: "deploy";
  readonly target: string;
  readonly host: string | null;
  readonly branch: string;
  readonly app: string | null;
  readonly migrations: DeployedMigrations | null;
  readonly problems: readonly string[];
  readonly ok: boolean;
}

export type VerifyReport = LocalVerifyReport | DeployVerifyReport;

const DEPLOY = "`databricks apps deploy`";
const LOGS = "`databricks apps logs`";
const POSTGRES_PERMISSION = "CAN_CONNECT_AND_CREATE";

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

async function verifyLocal(ctx: DbContext): Promise<LocalVerifyReport> {
  requireSchemaFile(ctx.root, "verify");
  const env = await resolveEnvBranch(ctx);
  if (!env) throw new Error(`Did not verify: ${NO_ENV_BRANCH}.`);
  const branch = env.branch.name;
  const schema = await loadDatabaseSchema(
    path.join(ctx.root, DEFAULT_SCHEMA_FILE),
    { keepImportErrorAsCause: true },
  );
  return withBranchPool(ctx, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("begin transaction read only");
      const { problems: schemaProblems, tablesInPublicAdvice } =
        await diagnoseSchema(rawOn(client), schema);
      const refusal = takesWrites(env.kind)
        ? forkCopyRefusal(
            branch,
            schema.$schemaName,
            await readSchemaState(client, schema.$schemaName),
            "migrate",
          )
        : undefined;
      const forkCopy = refusal ? shown(refusal) : null;
      const drift = await readMigrationDriftUnlocked(client, {
        migrationsFolder: migrationsFolder(ctx.root),
        schemaName: schema.$schemaName,
        ignoreHashes: [FORK_COPY_TAG],
      });
      return {
        kind: "local",
        branch,
        notYours: takesWrites(env.kind) ? null : (env.reason ?? null),
        refusesEveryBranch: everyBranchRefusal(env.boundary),
        schemaProblems,
        tablesInPublicAdvice,
        pendingMigrations: drift.pending,
        strandedMigrations: drift.stranded,
        editedMigrations: drift.edited,
        unknownMigrations: drift.unknownRecordedCount,
        forkCopy,
        ok:
          forkCopy === null &&
          schemaProblems.length === 0 &&
          drift.pending.length === 0 &&
          drift.stranded.length === 0 &&
          drift.edited.length === 0 &&
          drift.unknownRecordedCount === 0,
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
  readonly deployment_artifacts?: { readonly source_code_path?: string };
  readonly status?: DeploymentStatus;
}

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
    throw new Error(`Could not read app ${name}: ${shown(message)}`);
  }
}

async function exportFile(
  ctx: DbContext,
  file: string,
): Promise<Buffer | null> {
  let content: string | undefined;
  try {
    const response = await ctx.workspace().request({
      method: "GET",
      path: "/api/2.0/workspace/export",
      query: { path: file, format: "AUTO" },
    });
    ({ content } = (await response.json()) as { content?: string });
  } catch (error) {
    if ((error as { statusCode?: unknown } | null)?.statusCode === 404) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`exporting ${file} failed: ${message}`, { cause: error });
  }
  if (!content) throw new Error(`${file} exported no content`);
  return Buffer.from(content, "base64");
}

async function workspacePathExists(
  ctx: DbContext,
  file: string,
): Promise<boolean> {
  try {
    await ctx.workspace().request({
      method: "GET",
      path: "/api/2.0/workspace/get-status",
      query: { path: file },
    });
    return true;
  } catch (error) {
    if ((error as { statusCode?: unknown } | null)?.statusCode === 404) {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`reading the status of ${file} failed: ${message}`, {
      cause: error,
    });
  }
}

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

function parseDeployedJournal(bytes: Buffer, label: string): JournalEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not JSON: ${message}`, { cause: error });
  }
  const entries = parseJournal(json, label).entries;
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (
      typeof entry?.tag !== "string" ||
      !entry.tag ||
      typeof entry.idx !== "number" ||
      typeof entry.when !== "number"
    ) {
      throw new Error(
        `entry ${index} of ${label} is not a migration journal entry`,
      );
    }
    if (seen.has(entry.tag)) {
      throw new Error(`${label} lists ${entry.tag} twice`);
    }
    seen.add(entry.tag);
  });
  return entries;
}

type SourceFolder = { readonly folder: string } | { readonly reason: string };

function sourceFolder(
  root: string,
  file: string,
  name: string,
  declared: BundleApp["sourceCodePath"],
): SourceFolder {
  if (!declared) return { folder: root };
  if (declared.kind === "unresolved") {
    return {
      reason: `source_code_path of app ${name} in ${file} is "${declared.written}", which this checkout's files do not resolve to a folder`,
    };
  }
  const folder = path.resolve(root, declared.name);
  const migrations = path.relative(folder, migrationsFolder(root));
  if (migrations.startsWith("..") || path.isAbsolute(migrations)) {
    return {
      reason: `${path.relative(root, migrationsFolder(root)).split(path.sep).join("/")} is not inside source_code_path ${declared.name} of app ${name} in ${file}, so no deployment of it has the committed migrations`,
    };
  }
  return { folder };
}

async function readDeployedMigrations(
  ctx: DbContext,
  deployment: Deployment | undefined,
  committed: readonly CommittedMigration[],
  source: SourceFolder,
): Promise<DeployedMigrations | null> {
  if ("reason" in source) {
    return { evidence: "unavailable", reason: source.reason };
  }
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
    `${snapshot}/${path.relative(source.folder, file).split(path.sep).join("/")}`;
  try {
    const journalPath = deployedPath(journalFile(folder));
    const journal = await exportFile(ctx, journalPath);
    let deployed: JournalEntry[] = [];
    // A snapshot without a journal has no migration, but a 404 proves that
    // only for a snapshot that exists.
    if (!journal && !(await workspacePathExists(ctx, snapshot))) {
      throw new Error(`the source snapshot ${snapshot} does not exist`);
    }
    if (journal) deployed = parseDeployedJournal(journal, journalPath);
    const committedTags = new Set(committed.map(({ entry }) => entry.tag));
    const unknown = deployed.flatMap((entry) =>
      committedTags.has(entry.tag) ? [] : [entry.tag],
    );
    if (committed.length === 0) {
      if (deployed.length === 0) return null;
      const them = unknown.length === 1 ? "it" : "them";
      return {
        evidence: "unavailable",
        reason: `the deployment has ${unknown.map(shown).join(", ")}, and this checkout commits none in config/database/migrations next to databricks.yml: pull ${them}, then run verify again`,
      };
    }
    const deployedByTag = new Map(deployed.map((entry) => [entry.tag, entry]));
    const sameTags =
      unknown.length === 0 && deployed.length === committed.length;
    const compared = await Promise.all(
      committed.map(async ({ entry, sql }, index) => {
        const found = deployedByTag.get(entry.tag);
        if (!found) return "missing";
        if (
          (sameTags && deployed[index]?.tag !== entry.tag) ||
          found.idx !== entry.idx ||
          found.when !== entry.when ||
          found.breakpoints !== entry.breakpoints
        ) {
          return "changed";
        }
        const file = deployedPath(migrationFile(folder, entry.tag));
        const bytes = await exportFile(ctx, file);
        if (!bytes) {
          throw new Error(
            `${file} is listed in the deployed journal but missing from the snapshot`,
          );
        }
        if (bytes.equals(sql)) return "same";
        return withLf(bytes) === withLf(sql) ? "lineEndings" : "changed";
      }),
    );
    const tags = (status: "missing" | "changed" | "lineEndings") =>
      committed
        .filter((_, index) => compared[index] === status)
        .map(({ entry }) => entry.tag);
    const missing = tags("missing");
    const changed = tags("changed");
    const lineEndings = tags("lineEndings");
    return missing.length === 0 &&
      changed.length === 0 &&
      lineEndings.length === 0 &&
      unknown.length === 0
      ? { evidence: "verified" }
      : { evidence: "differs", missing, changed, lineEndings, unknown };
  } catch (error) {
    return {
      evidence: "unavailable",
      reason: shown(error instanceof Error ? error.message : String(error)),
    };
  }
}

const withLf = (bytes: Buffer) =>
  bytes.toString("utf-8").replace(/\r\n/g, "\n");

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
  const { missing, changed, lineEndings, unknown } = migrations;
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
  if (lineEndings.length > 0) {
    const it = lineEndings.length === 1 ? "it" : "them";
    problems.push(
      `app ${name}'s active deployment has ${lineEndings.join(", ")} with the same SQL as this checkout commits, but other line endings (CRLF or LF). The app's start treats either line ending as the same file, but verify compares bytes: check ${it} out with the line endings that were deployed, or run ${DEPLOY} to deploy ${it} as committed`,
    );
  }
  if (unknown.length > 0) {
    const them = unknown.length === 1 ? "it" : "them";
    problems.push(
      `app ${name}'s active deployment has ${unknown.map(shown).join(", ")}, which this checkout does not commit: pull ${them}, then run verify again`,
    );
  }
  return problems;
}

function bindingProblems(
  app: DeployedApp,
  name: string,
  branch: string,
  database: string | null,
  file: string,
  source: string,
): string[] {
  const bound = (app.resources ?? []).flatMap((resource) =>
    resource.postgres ? [resource.postgres] : [],
  );
  const binding = bound.find((postgres) => postgres.branch === branch);
  if (!binding) {
    return [
      bound.length > 0
        ? `app ${name} uses branch ${bound.map((postgres) => shown(postgres.branch ?? "(none)")).join(", ")}, not ${branch} from ${source}: ${DEPLOY} applies ${source}`
        : `app ${name} has no postgres resource: ${DEPLOY} adds the one ${file} declares`,
    ];
  }
  const problems: string[] = [];
  if (database && binding.database !== database) {
    problems.push(
      `app ${name} uses database ${shown(binding.database ?? "(none)")}, not ${database} from ${source}: ${DEPLOY} applies ${source}`,
    );
  }
  if (binding.permission !== POSTGRES_PERMISSION) {
    problems.push(
      `app ${name}'s postgres resource has permission ${shown(binding.permission ?? "(none)")}, but the app needs ${POSTGRES_PERMISSION} to create its schema: set it in ${file}, then run ${DEPLOY}`,
    );
  }
  return problems;
}

function detail(message: string | undefined): string {
  const text = message?.trim().replace(/\.+$/, "");
  return text ? `: ${shown(text)}` : "";
}

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
      `app ${name}'s compute is ${shown(compute.state.toLowerCase())}${detail(compute.message)}`,
    ];
  }
  const status = app.app_status;
  if (status?.state === "RUNNING") return [];
  return [
    `app ${name} is ${shown(status?.state?.toLowerCase() ?? "not running")}${detail(status?.message)}. ${LOGS} shows why; a migration that fails stops the app on start`,
  ];
}

function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return url.toLowerCase();
  }
}

async function assertTargetWorkspace(
  ctx: DbContext,
  target: string,
  host: string | null,
  profile: string | null,
): Promise<void> {
  if (!host && !profile) return;
  let expected = host;
  if (!expected && profile) {
    try {
      expected = await profileHost(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Target ${target} deploys with profile ${profile}, which this machine's Databricks config does not resolve to a workspace host: ${message.replace(/\.+$/, "")}. Add the profile, or set workspace.host in target ${target}, then rerun.`,
        { cause: error },
      );
    }
  }
  if (!expected) return;
  const authenticated = await ctx.workspace().getHost();
  if (hostOf(authenticated) === hostOf(expected)) return;
  throw new Error(
    host
      ? `Target ${target} deploys to ${host}, but this shell is authenticated against ${authenticated}. Set DATABRICKS_CONFIG_PROFILE to a profile for ${host}, then rerun.`
      : `Target ${target} deploys with profile ${profile} to ${expected}, but this shell is authenticated against ${authenticated}. Set DATABRICKS_CONFIG_PROFILE=${profile}, then rerun.`,
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

async function verifyDeploy(
  ctx: DbContext,
  targetName: string | undefined,
): Promise<DeployVerifyReport> {
  const bundle = readBundle(ctx.root, ctx.env);
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
  const deploy = target.environment ?? target.overridden ?? target;
  const applied = target.environment
    ? [target.environment.file, target.environment.variables]
    : [target.overridden?.file];
  const values = applied.filter(Boolean).join(" and ");
  const withValues = values ? ` with ${values}` : "";
  const source = `${file}${withValues}`;
  const bound = deploy.apps.filter((app) => app.postgres.length > 0);
  if (bound.length > 1) {
    throw new Error(
      `Target ${target.name} deploys ${bound.length} apps with a postgres resource (${bound.map((app) => app.key).join(", ")}); verify checks one app per target.`,
    );
  }
  const app =
    bound[0] ?? (deploy.apps.length === 1 ? deploy.apps[0] : undefined);
  if (app && app.postgres.length > 1) {
    throw new Error(
      `App ${app.key} in target ${target.name} has ${app.postgres.length} postgres resources (${app.postgres.map((binding) => binding.at).join(", ")}); verify checks one per app.`,
    );
  }
  const declared = app?.postgres[0];
  const branchValue = declared ? declared.branch : deploy.postgresBranch;
  if (!branchValue) {
    throw new Error(
      `No deploy branch: target ${target.name} in ${file} declares no app with a postgres resource.`,
    );
  }
  if (branchValue.kind === "unresolved") {
    throw new Error(
      `No deploy branch: ${declared ? `${declared.at}.branch` : "variables.postgres_branch"} in target ${target.name}${withValues} is "${branchValue.written}", which this checkout's files do not resolve to a branch.`,
    );
  }
  const databaseValue = declared ? declared.database : deploy.postgresDatabase;
  if (databaseValue?.kind === "unresolved") {
    throw new Error(
      `No deploy database: ${declared ? `${declared.at}.database` : "variables.postgres_database"} in target ${target.name}${withValues} is "${databaseValue.written}", which this checkout's files do not resolve to a database.`,
    );
  }
  if (deploy.host?.kind === "unresolved") {
    throw new Error(
      `No target workspace: workspace.host in target ${target.name}${withValues} is "${deploy.host.written}", which this checkout's files do not resolve to a host. Give the variable it names a value in ${file}, or in .databricks/bundle/${target.name}/variable-overrides.json, then rerun.`,
    );
  }
  if (!deploy.host && deploy.profile?.kind === "unresolved") {
    throw new Error(
      `No target workspace: workspace.profile in target ${target.name}${withValues} is "${deploy.profile.written}", which this checkout's files do not resolve to a profile. Give the variable it names a value in ${file}, or in .databricks/bundle/${target.name}/variable-overrides.json, then rerun.`,
    );
  }
  const branch = branchValue.name;
  const database = databaseValue?.name ?? null;
  const host = deploy.host?.name ?? null;
  const profile =
    deploy.profile?.kind === "resolved" ? deploy.profile.name : null;
  const committed = readCommitted(migrationsFolder(ctx.root));
  const report = (
    name: string | null,
    problems: string[],
    migrations: DeployedMigrations | null,
  ): DeployVerifyReport => ({
    kind: "deploy",
    target: target.name,
    host,
    branch,
    app: name,
    migrations,
    problems,
    ok:
      problems.length === 0 &&
      (migrations === null || migrations.evidence === "verified"),
  });
  const stopped = (name: string | null, problems: string[]) =>
    report(name, problems, {
      evidence: "unavailable",
      reason: "verify stopped before reading the app's deployment",
    });
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

  await assertTargetWorkspace(ctx, target.name, host, profile);
  const api = ctx.api();
  const [branchFound, databaseFound, deployed] = await Promise.all([
    api.getBranch(branch),
    database ? api.getDatabase(database) : null,
    readApp(ctx, name),
  ]);
  const branchId = resourceId(branch);
  if (!branchFound) {
    return stopped(name, [
      `${source} deploys to ${branch}, which does not exist`,
    ]);
  }
  const problems: string[] = [];
  if (database && !databaseFound) {
    problems.push(
      `${source} binds database ${database}, which does not exist on ${branchId}`,
    );
  }
  if (!deployed) {
    problems.push(
      `app ${name} is not deployed yet: ${DEPLOY} creates it and gives it access to ${branchId}`,
    );
    return stopped(name, problems);
  }

  const binding = bindingProblems(
    deployed,
    name,
    branch,
    database,
    file,
    source,
  );
  problems.push(...binding, ...runningProblems(deployed, name));
  const sp = deployed.service_principal_client_id;
  if (!sp) {
    problems.push(
      `the API reports no service principal for app ${name}, so verify cannot tell whether it has a Postgres role on ${branchId}: \`databricks apps get ${name}\` shows the app; run verify again once it has one`,
    );
  }
  const [roles, migrations] = await Promise.all([
    sp && binding.length === 0 ? api.listRoles(branch) : null,
    readDeployedMigrations(
      ctx,
      deployed.active_deployment,
      committed,
      sourceFolder(ctx.root, file, name, app.sourceCodePath),
    ),
  ]);
  if (roles && !roles.some((role) => role.status?.postgres_role === sp)) {
    problems.push(
      `the app's service principal ${shown(sp ?? "")} has no Postgres role on ${branchId}: ${DEPLOY} creates it from the app's postgres resource`,
    );
  }
  if (migrations && deployed.active_deployment) {
    problems.push(...migrationsProblems(name, migrations));
  }
  return report(name, problems, migrations);
}

export async function runVerify(
  ctx: DbContext,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  return options.deployed
    ? verifyDeploy(ctx, options.target)
    : verifyLocal(ctx);
}
