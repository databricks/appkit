import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

import { FOREIGN_OWNERS_SQL } from "../migrations/ownership";
import { runClean } from "./clean";
import { type DbContext, openBranchPool } from "./context";
import { updateEnvFile } from "./env-file";
import { classifyBranch } from "./guard";
import { currentIdentity, type Identity } from "./identity";
import { type IntrospectReport, runIntrospect } from "./introspect";
import {
  type LakebaseBranch,
  LakebaseApiError,
  type LakebaseEndpoint,
  type LakebaseRole,
  READ_WRITE_ENDPOINT,
  SUPERUSER_MEMBERSHIP,
} from "./lakebase-api";
import {
  hasSchemaFile,
  type MigrateReport,
  requireSchemaFile,
  runMigrate,
} from "./migrate";
import {
  devBranchId,
  newSessionId,
  SESSION_BRANCH_TTL,
  sessionBranchId,
} from "./naming";
import {
  type BranchMode,
  type DeployTarget,
  type LocalTarget,
  parseResourceName,
  readDeployBranches,
  readDeployTarget,
  readLocalTarget,
  resourceId,
} from "./targets";

/** How init leaves the schema. */
export type SchemaStart = "migrate" | "introspect" | "clean";
/**
 * The starts worth offering, the default first. Without schema.ts there is
 * nothing to migrate and no schema name to clean, so introspect is the only
 * start that can run.
 */
export function schemaStartsFor(hasSchema: boolean): readonly SchemaStart[] {
  return hasSchema ? ["migrate", "introspect", "clean"] : ["introspect"];
}

export function defaultSchemaStart(hasSchema: boolean): SchemaStart {
  return schemaStartsFor(hasSchema)[0] as SchemaStart;
}

export interface InitChoices {
  readonly mode: BranchMode;
  /** null leaves the schema as it is. */
  readonly schemaStart: SchemaStart | null;
}

export interface InitOptions {
  /** Passed to migrate: false makes an ambiguous rename fail instead of prompting. */
  readonly interactive: boolean;
}

type RoleAction = "kept" | "created" | "updated";

export interface InitReport {
  readonly mode: BranchMode;
  readonly branch: string;
  readonly created: boolean;
  /** The branch a new fork was created from. */
  readonly sourceBranch?: string;
  readonly endpoint: string;
  readonly endpointCreated: boolean;
  readonly host: string;
  readonly database: string;
  readonly user: string;
  readonly role: { readonly name: string; readonly action: RoleAction };
  /** Postgres roles whose objects on this branch were handed to the developer. */
  readonly handedOff: readonly string[];
  readonly envFile: string;
  readonly cleaned: boolean;
  readonly schema: MigrateReport | null;
  readonly introspect: IntrospectReport | null;
}

const ENV_FILE = ".env";
const ENV_EXAMPLE = ".env.example";
const DEFAULT_ENDPOINT_ID = "primary";
/** Every Lakebase branch has it; used when nothing names another database. */
const DEFAULT_DATABASE = "databricks_postgres";

/**
 * The mode `.env`'s branch implies: your dev branch is "dev", this checkout's
 * session branch (APPKIT_DB_SESSION) is "session". Null for any other branch,
 * without an endpoint, or when it belongs to another project than the
 * configured one: init then asks, or uses "dev" without prompts.
 */
export async function currentBranchMode(
  ctx: DbContext,
): Promise<BranchMode | null> {
  const local = readLocalTarget(ctx.env);
  const current = parseResourceName(local.endpoint ?? undefined);
  if (!current?.branch) return null;
  if (local.project && current.project !== local.project) return null;
  const branchId = resourceId(current.branch);
  if (local.session && branchId === sessionBranchId(local.session)) {
    return "session";
  }
  const identity = await currentIdentity(ctx);
  return branchId === devBranchId(identity.userName) ? "dev" : null;
}

/** The mode `.env`'s branch implies (null without one), and whether schema.ts exists. */
export async function resolveInitDefaults(ctx: DbContext): Promise<{
  mode: BranchMode | null;
  hasSchema: boolean;
}> {
  return {
    mode: await currentBranchMode(ctx),
    hasSchema: hasSchemaFile(ctx.root),
  };
}

/** LAKEBASE_PROJECT, else the project of LAKEBASE_ENDPOINT, else of the bundle's postgres_branch. */
function resolveProject(
  local: LocalTarget,
  deploy: DeployTarget | null,
): string {
  const project =
    local.project ??
    parseResourceName(local.endpoint ?? undefined)?.project ??
    parseResourceName(deploy?.branch)?.project;
  if (!project) {
    throw new Error(
      "No Lakebase project configured. Set LAKEBASE_PROJECT=projects/<project-id> in .env, or bind postgres_branch in databricks.yml (`databricks apps init` does).",
    );
  }
  return project;
}

/** Drop .env connection values and a deploy binding that belong to another project than LAKEBASE_PROJECT. */
function scopeToProject(
  project: string,
  local: LocalTarget,
  deploy: DeployTarget | null,
): { local: LocalTarget; deploy: DeployTarget | null } {
  const inProject = (name: string | null | undefined) =>
    parseResourceName(name ?? undefined)?.project === project;
  return {
    local: inProject(local.endpoint)
      ? local
      : { ...local, endpoint: null, database: null },
    deploy: deploy && inProject(deploy.branch) ? deploy : null,
  };
}

function isExpired(branch: LakebaseBranch, now = Date.now()): boolean {
  if (branch.status?.current_state === "DELETED") return true;
  const expires = branch.status?.expire_time;
  return !!expires && Date.parse(expires) <= now;
}

/** Find dev-…/session-… with one GET, or fork the project's default branch. */
async function findOrCreateBranch(
  ctx: DbContext,
  project: string,
  mode: BranchMode,
  identity: Identity,
  session: string | null,
): Promise<{
  branch: LakebaseBranch;
  created: boolean;
  sourceBranch?: string;
  session: string | null;
}> {
  const api = ctx.api();
  let sessionId = mode === "session" ? (session ?? newSessionId()) : null;
  const idFor = () =>
    mode === "dev"
      ? devBranchId(identity.userName)
      : sessionBranchId(sessionId as string);

  let existing = await api.getBranch(`${project}/branches/${idFor()}`);
  if (existing && isExpired(existing)) {
    if (mode === "dev") {
      throw new Error(
        `Your dev branch ${existing.name} was deleted. Restore it, or delete it for good, then rerun \`appkit db init\`.`,
      );
    }
    // An expired session branch is replaced by a fresh session.
    sessionId = newSessionId();
    existing = await api.getBranch(`${project}/branches/${idFor()}`);
  }
  if (existing) return { branch: existing, created: false, session: sessionId };

  const parent = (await api.listBranches(project)).find(
    (b) => b.status?.default,
  );
  if (!parent) {
    throw new Error(`Project ${project} has no default branch to fork from.`);
  }
  const id = idFor();
  if (sessionId && sessionId !== session) {
    // Written first, so a failed or interrupted run reuses this id instead of forking again.
    updateEnvFile(
      path.join(ctx.root, ENV_FILE),
      { APPKIT_DB_SESSION: sessionId },
      path.join(ctx.root, ENV_EXAMPLE),
    );
  }
  try {
    const branch = await api.createBranch(project, id, {
      source_branch: parent.name,
      ...(mode === "dev"
        ? { no_expiry: true as const }
        : { ttl: SESSION_BRANCH_TTL }),
    });
    return {
      branch: branch?.name ? branch : { name: `${project}/branches/${id}` },
      created: true,
      sourceBranch: parent.name,
      session: sessionId,
    };
  } catch (error) {
    if (error instanceof LakebaseApiError && error.statusCode === 403) {
      throw new LakebaseApiError(
        error.operation,
        `creating ${id} needs CAN MANAGE on ${project}. Ask a project owner for it.`,
        { statusCode: 403, cause: error },
      );
    }
    if (error instanceof LakebaseApiError && error.statusCode === 409) {
      // Another run created it first.
      const raced = await api.getBranch(`${project}/branches/${id}`);
      if (raced) return { branch: raced, created: false, session: sessionId };
    }
    throw error;
  }
}

async function ensureReadWriteEndpoint(
  ctx: DbContext,
  branch: string,
): Promise<{ endpoint: LakebaseEndpoint; created: boolean; host: string }> {
  const api = ctx.api();
  const readWrite = (endpoints: LakebaseEndpoint[]) =>
    endpoints.find((e) => e.status?.endpoint_type === READ_WRITE_ENDPOINT);

  let endpoint = readWrite(await api.listEndpoints(branch));
  let created = false;
  if (!endpoint) {
    endpoint = await api.createEndpoint(branch, DEFAULT_ENDPOINT_ID);
    created = true;
  }
  let host = endpoint?.status?.hosts?.host;
  if (!host) {
    endpoint = readWrite(await api.listEndpoints(branch)) ?? endpoint;
    host = endpoint?.status?.hosts?.host;
  }
  if (!endpoint?.name || !host) {
    throw new Error(
      `The read-write endpoint of ${branch} has no host yet. Rerun \`appkit db init\` in a minute.`,
    );
  }
  return { endpoint, created, host };
}

async function ensureDeveloperRole(
  ctx: DbContext,
  branch: string,
  identity: Identity,
  roles: readonly LakebaseRole[],
): Promise<{ role: LakebaseRole; action: RoleAction }> {
  const api = ctx.api();
  const existing = roles.find(
    (r) => r.status?.postgres_role === identity.userName,
  );
  if (!existing) {
    const role = await api.createRole(branch, {
      identity_type: identity.identityType,
      postgres_role: identity.userName,
      auth_method: "LAKEBASE_OAUTH_V1",
      membership_roles: [SUPERUSER_MEMBERSHIP],
    });
    if (!role?.name) {
      // The operation response normally carries the role; fall back to a lookup.
      const found = (await api.listRoles(branch)).find(
        (r) => r.status?.postgres_role === identity.userName,
      );
      if (!found)
        throw new Error(`Creating your role on ${branch} did not return it.`);
      return { role: found, action: "created" };
    }
    return { role, action: "created" };
  }
  if (existing.status?.membership_roles?.includes(SUPERUSER_MEMBERSHIP)) {
    return { role: existing, action: "kept" };
  }
  const role = await api.setRoleMemberships(existing.name, [
    SUPERUSER_MEMBERSHIP,
  ]);
  return { role: role?.name ? role : existing, action: "updated" };
}

/**
 * A fork copies its parent's objects with their owners. Hand
 * every object owned by another role-API role to the developer, by deleting that
 * role's copy on this branch with reassign_owned_to. Idempotent: nothing owned
 * by others means no API call.
 */
async function handOffOwnership(
  ctx: DbContext,
  developerRole: LakebaseRole,
  roles: readonly LakebaseRole[],
): Promise<string[]> {
  const pool = await openBranchPool(ctx);
  if (!pool)
    throw new Error("The branch connection settings were not written to .env.");
  let owners: Set<string>;
  try {
    const { rows } = await pool.query<{ owner: string }>(FOREIGN_OWNERS_SQL);
    owners = new Set(rows.map((row) => row.owner));
  } finally {
    await pool.end().catch(() => undefined);
  }

  const handedOff: string[] = [];
  for (const role of roles) {
    const postgresRole = role.status?.postgres_role;
    if (
      !postgresRole ||
      role.name === developerRole.name ||
      !owners.has(postgresRole)
    ) {
      continue;
    }
    await ctx
      .api()
      .deleteRole(role.name, { reassignOwnedTo: developerRole.name });
    handedOff.push(postgresRole);
  }
  return handedOff;
}

async function resolveDatabase(
  ctx: DbContext,
  branch: string,
  local: LocalTarget,
  deploy: DeployTarget | null,
): Promise<string> {
  // A real .env endpoint came with its database; forks inherit the parent's databases.
  if (local.database) return local.database;
  if (deploy?.database) {
    const database = await ctx
      .api()
      .getDatabase(`${branch}/databases/${resourceId(deploy.database)}`);
    if (database?.status?.postgres_database)
      return database.status.postgres_database;
  }
  return DEFAULT_DATABASE;
}

function readEnvValues(file: string): Record<string, string> {
  return fs.existsSync(file)
    ? dotenv.parse(fs.readFileSync(file, "utf-8"))
    : {};
}

/**
 * `appkit db init`: find or create the developer's dev branch or this
 * checkout's session branch, ensure a read-write endpoint and the developer's
 * DATABRICKS_SUPERUSER role, hand copied objects to the developer, point `.env`
 * at the branch, then apply the schema start. It refuses a branch that is the
 * project's default, protected or one databricks.yml deploys to before
 * changing anything on it, and never touches the deploy bundle.
 */
export async function runInit(
  ctx: DbContext,
  choices: InitChoices,
  options: InitOptions = { interactive: false },
): Promise<InitReport> {
  // Before any change: migrate and clean cannot run without schema.ts.
  if (choices.schemaStart === "migrate" || choices.schemaStart === "clean") {
    requireSchemaFile(ctx.root, choices.schemaStart);
  }
  const api = ctx.api();
  const configured = {
    local: readLocalTarget(ctx.env),
    deploy: readDeployTarget(ctx.root),
  };
  const project = resolveProject(configured.local, configured.deploy);
  const { local, deploy } = scopeToProject(
    project,
    configured.local,
    configured.deploy,
  );
  const identity = await currentIdentity(ctx);

  const deployBranches = readDeployBranches(ctx.root);

  // 1. Branch; init never changes a branch the app deploys to.
  const found = await findOrCreateBranch(
    ctx,
    project,
    choices.mode,
    identity,
    local.session,
  );
  const { branch, created, sourceBranch } = found;
  const session = found.session ?? local.session;
  const verdict = classifyBranch({
    branch,
    userName: identity.userName,
    sessionId: session,
    deployBranches,
  });
  if (!verdict.appkitOwned) {
    throw new Error(
      `Refusing to set up ${resourceId(branch.name)}: ${verdict.reason ?? "it is not an AppKit branch"}. \`appkit db init\` only sets up your dev branch or this checkout's session branch, never a branch the app deploys to.`,
    );
  }

  // 2. Endpoint and role.
  const {
    endpoint,
    created: endpointCreated,
    host,
  } = await ensureReadWriteEndpoint(ctx, branch.name);
  const roles = await api.listRoles(branch.name);
  const { role, action } = await ensureDeveloperRole(
    ctx,
    branch.name,
    identity,
    roles,
  );
  const database = await resolveDatabase(ctx, branch.name, local, deploy);

  // 3. .env, replaced in place; the running context sees the new branch.
  const envFile = path.join(ctx.root, ENV_FILE);
  const current = readEnvValues(
    fs.existsSync(envFile) ? envFile : path.join(ctx.root, ENV_EXAMPLE),
  );
  const values: Record<string, string> = {
    LAKEBASE_PROJECT: project,
    PGHOST: host,
    LAKEBASE_ENDPOINT: endpoint.name,
    PGDATABASE: database,
    PGUSER: identity.userName,
    ...(choices.mode === "session" && session
      ? { APPKIT_DB_SESSION: session }
      : {}),
    ...(current.PGPORT && /^\d+$/.test(current.PGPORT)
      ? {}
      : { PGPORT: "5432" }),
    ...(current.PGSSLMODE ? {} : { PGSSLMODE: "require" }),
  };
  updateEnvFile(envFile, values, path.join(ctx.root, ENV_EXAMPLE));
  Object.assign(ctx.env, values);

  // 4. Ownership hand-off: the fork's copies become the developer's.
  const handedOff = await handOffOwnership(ctx, role, roles);

  // 5. Schema start.
  let schema: MigrateReport | null = null;
  let introspect: IntrospectReport | null = null;
  let cleaned = false;
  if (choices.schemaStart === "introspect") {
    introspect = await runIntrospect(ctx, { interactive: options.interactive });
  } else if (choices.schemaStart === "migrate") {
    schema = await runMigrate(ctx, { interactive: options.interactive });
  } else if (choices.schemaStart === "clean") {
    await runClean(ctx);
    cleaned = true;
    // Recreate from the committed migrations, so the startup check passes.
    schema = await runMigrate(ctx, {
      interactive: options.interactive,
      generate: false,
    });
  }

  return {
    mode: choices.mode,
    branch: branch.name,
    created,
    ...(sourceBranch ? { sourceBranch } : {}),
    endpoint: endpoint.name,
    endpointCreated,
    host,
    database,
    user: identity.userName,
    role: { name: role.name, action },
    handedOff,
    envFile,
    cleaned,
    schema,
    introspect,
  };
}
