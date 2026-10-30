import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

import { loadDefaultDatabaseSchema } from "../../plugins/database/load-schema";
import { DEFAULT_SCHEMA_NAME } from "../schema-builder/define-schema";
import { type CleanReport, cleanHolding } from "./clean";
import type { DbContext } from "./context";
import {
  ensureDrizzleKit,
  type RunCommand,
  runCommand,
} from "./drizzle-kit-install";
import { refuseSymlink, updateEnvFile } from "./env-file";
import {
  classifyBranch,
  deployRefusal,
  takesWrites,
  writeRefusal,
} from "./guard";
import { handOffAppSchema } from "./hand-off";
import { type HistoryLock, withHistoryLock } from "./history-lock";
import { currentIdentity, type Identity } from "./identity";
import { introspectHolding, type IntrospectReport } from "./introspect";
import {
  isAlreadyExists,
  isBranchLimit,
  isPermissionDenied,
  type LakebaseBranch,
  type LakebaseEndpoint,
  type LakebaseRole,
  READ_WRITE_ENDPOINT,
  SUPERUSER_MEMBERSHIP,
} from "./lakebase-api";
import {
  hasSchemaFile,
  type MigrateReport,
  migrateHolding,
  requireSchemaFile,
} from "./migrate";
import {
  devBranchId,
  isUsersBranchId,
  newSessionId,
  parseTtl,
  SESSION_BRANCH_TTL,
  sessionBranchId,
} from "./naming";
import {
  type BranchMode,
  type DeployBoundary,
  type DeployTarget,
  type LocalTarget,
  parseResourceName,
  readDeployBoundary,
  readDeployTarget,
  readLocalTarget,
  resourceId,
} from "./targets";

/** How init leaves the schema; "none" leaves it as the fork has it. */
export type SchemaStart = "migrate" | "introspect" | "clean" | "none";

export interface InitOptions {
  /** Default: this checkout's session branch when .env points at it, else your dev branch. */
  readonly mode?: BranchMode;
  /** Default: migrate when schema.ts exists, introspect otherwise. */
  readonly schema?: SchemaStart;
  /** A new session branch's TTL as `--ttl` takes it (30m, 1h, 7d); default seven days. */
  readonly ttl?: string;
  /** Passed to migrate and introspect: false makes an ambiguous rename fail instead of prompting. */
  readonly interactive?: boolean;
  /** One line per step that calls the Lakebase API or changes a file. */
  readonly onStep?: (message: string) => void;
  /** Runs the drizzle-kit install. */
  readonly runCommand?: RunCommand;
}

type RoleAction = "kept" | "created" | "updated";

export type InitStart =
  | { readonly kind: "none" }
  | { readonly kind: "migrate"; readonly migrate: MigrateReport }
  | { readonly kind: "introspect"; readonly introspect: IntrospectReport }
  | {
      readonly kind: "clean";
      readonly clean: CleanReport;
      readonly migrate: MigrateReport;
    };

export interface InitReport {
  readonly mode: BranchMode;
  readonly branch: string;
  readonly created: boolean;
  /** The branch a new fork was created from. */
  readonly sourceBranch?: string;
  /** When the branch expires; null for a branch without expiry. */
  readonly expireTime: string | null;
  readonly endpoint: string;
  readonly endpointCreated: boolean;
  readonly host: string;
  readonly database: string;
  readonly user: string;
  readonly role: { readonly name: string; readonly action: RoleAction };
  /**
   * The Postgres role whose copy of the app schema was handed to you; null when
   * you owned it, the schema is public, or `--schema none` left it alone.
   */
  readonly handedOff: string | null;
  readonly envFile: string;
  /** The drizzle-kit install init ran; null when it was installed. */
  readonly installed: string | null;
  readonly start: InitStart;
}

const ENV_FILE = ".env";
const DEFAULT_ENDPOINT_ID = "primary";
/** An idle compute counts against the project's 20 active ones. */
const SUSPEND_TIMEOUT = "300s";
/** Every Lakebase branch has it; used when nothing names another database. */
const DEFAULT_DATABASE = "databricks_postgres";

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

/** Session when .env points at this checkout's session branch; dev otherwise. */
function defaultMode(local: LocalTarget, userName: string): BranchMode {
  const branch = parseResourceName(local.endpoint ?? undefined)?.branch;
  return local.session &&
    branch &&
    resourceId(branch) === sessionBranchId(userName, local.session)
    ? "session"
    : "dev";
}

function isGone(branch: LakebaseBranch, now = Date.now()): boolean {
  if (branch.status?.current_state === "DELETED") return true;
  const expires = branch.status?.expire_time;
  return !!expires && Date.parse(expires) <= now;
}

interface BranchRequest {
  readonly project: string;
  readonly mode: BranchMode;
  readonly identity: Identity;
  readonly session: string | null;
  /** The API's duration ("3600s"), and how the developer wrote it. */
  readonly ttl: { readonly api: string; readonly label: string };
  readonly boundary: DeployBoundary;
  readonly envFile: string;
  readonly onStep: (message: string) => void;
}

interface FoundBranch {
  readonly branch: LakebaseBranch;
  readonly created: boolean;
  readonly sourceBranch?: string;
  readonly session: string | null;
}

function branchLimitError(
  project: string,
  branches: readonly LakebaseBranch[],
  userName: string,
  cause: unknown,
): Error {
  const yours = branches.filter(
    (b) => isUsersBranchId(userName, resourceId(b.name)) && !isGone(b),
  );
  const message =
    yours.length > 0
      ? `Project ${project} is at its branch limit, so init created nothing. Delete one of your other branches, then rerun \`appkit db init\`:\n${yours
          .map(
            (b) =>
              `  databricks postgres delete-branch ${b.name}${b.status?.expire_time ? `  # expires ${b.status.expire_time}` : ""}`,
          )
          .join("\n")}`
      : `Project ${project} is at its branch limit, so init created nothing, and none of its branches are yours. Ask a project owner to delete unused branches, then rerun \`appkit db init\`.`;
  return new Error(message, { cause });
}

/** What init says after refusing a branch, unless every branch is refused. */
const INIT_SETS_UP =
  "`appkit db init` only sets up your dev branch or this checkout's session branch";

/**
 * Your dev branch or this checkout's session branch: found with one GET, or
 * forked from the project's default branch. The branch id is resolved and
 * checked against databricks.yml before any API call or .env write. An expired
 * session branch gets a new session id; an expired dev branch is an error.
 */
async function findOrCreateBranch(
  ctx: DbContext,
  request: BranchRequest,
): Promise<FoundBranch> {
  const { project, mode, identity, boundary, onStep } = request;
  const api = ctx.api();
  let session = mode === "session" ? (request.session ?? newSessionId()) : null;
  let rotated = false;
  const branchName = () =>
    `${project}/branches/${
      session === null
        ? devBranchId(identity.userName)
        : sessionBranchId(identity.userName, session)
    }`;

  const reuse = (branch: LakebaseBranch): FoundBranch => {
    const verdict = classifyBranch({
      branch,
      userName: identity.userName,
      sessionId: session,
      boundary,
    });
    if (!takesWrites(verdict.kind)) {
      throw new Error(
        `Refusing to set up ${writeRefusal(`${resourceId(branch.name)}: ${verdict.reason}`, boundary, INIT_SETS_UP)}.`,
      );
    }
    onStep(`Using ${resourceId(branch.name)}`);
    return { branch, created: false, session };
  };
  const replaceGone = (name: string): void => {
    if (session === null) {
      throw new Error(
        `Your dev branch ${name} was deleted or expired. Restore it, or delete it for good, then rerun \`appkit db init\`. \`appkit db init --session\` sets up a session branch meanwhile.`,
      );
    }
    if (rotated) {
      throw new Error(
        `Could not create a session branch: ${name} was deleted or expired too. Rerun \`appkit db init --session\`.`,
      );
    }
    rotated = true;
    session = newSessionId();
  };

  for (;;) {
    const name = branchName();
    const refusal = deployRefusal(boundary, name);
    if (refusal) {
      throw new Error(
        `Refusing to set up ${writeRefusal(`${resourceId(name)}: ${refusal}`, boundary, INIT_SETS_UP)}.`,
      );
    }
    const existing = await api.getBranch(name);
    if (existing && !isGone(existing)) return reuse(existing);
    if (existing) {
      replaceGone(name);
      continue;
    }

    const branches = await api.listBranches(project);
    const parent = branches.find((b) => b.status?.default);
    if (!parent) {
      throw new Error(`Project ${project} has no default branch to fork from.`);
    }
    if (session !== null && session !== request.session) {
      // Written first, so a failed or interrupted run reuses this id instead of forking again.
      updateEnvFile(request.envFile, { APPKIT_DB_SESSION: session });
    }
    onStep(
      `Creating ${resourceId(name)} from ${resourceId(parent.name)}${session === null ? "" : `, expiring after ${request.ttl.label}`}`,
    );
    try {
      const branch = await api.createBranch(project, resourceId(name), {
        source_branch: parent.name,
        ...(session === null
          ? { no_expiry: true as const }
          : { ttl: request.ttl.api }),
      });
      return {
        branch: branch?.name ? branch : { name },
        created: true,
        sourceBranch: parent.name,
        session,
      };
    } catch (error) {
      if (isPermissionDenied(error)) {
        throw new Error(
          `Creating ${resourceId(name)} needs CAN MANAGE on ${project}. Ask a project owner for it, then rerun \`appkit db init\`.`,
          { cause: error },
        );
      }
      if (isBranchLimit(error)) {
        throw branchLimitError(project, branches, identity.userName, error);
      }
      if (!isAlreadyExists(error)) throw error;
      // Another run created it first, or the name is held by a deleted branch.
      const raced = await api.getBranch(name);
      if (raced && !isGone(raced)) return reuse(raced);
      replaceGone(name);
    }
  }
}

async function ensureReadWriteEndpoint(
  ctx: DbContext,
  branch: string,
  onStep: (message: string) => void,
): Promise<{ endpoint: LakebaseEndpoint; created: boolean; host: string }> {
  const api = ctx.api();
  const readWrite = (endpoints: LakebaseEndpoint[]) =>
    endpoints.find((e) => e.status?.endpoint_type === READ_WRITE_ENDPOINT);

  let endpoint = readWrite(await api.listEndpoints(branch));
  let created = false;
  if (!endpoint) {
    onStep(
      `Creating a read-write endpoint on ${resourceId(branch)} that suspends after 5 idle minutes`,
    );
    endpoint = await api.createEndpoint(branch, DEFAULT_ENDPOINT_ID, {
      suspendTimeout: SUSPEND_TIMEOUT,
    });
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
  onStep: (message: string) => void,
): Promise<{ role: LakebaseRole; action: RoleAction }> {
  const api = ctx.api();
  const existing = roles.find(
    (r) => r.status?.postgres_role === identity.userName,
  );
  if (!existing) {
    onStep(
      `Creating your role ${identity.userName} with ${SUPERUSER_MEMBERSHIP}`,
    );
    const role = await api.createRole(branch, {
      identity_type: identity.identityType,
      postgres_role: identity.userName,
      auth_method: "LAKEBASE_OAUTH_V1",
      membership_roles: [SUPERUSER_MEMBERSHIP],
    });
    if (role?.name) return { role, action: "created" };
    // The operation response normally carries the role; fall back to a lookup.
    const found = (await api.listRoles(branch)).find(
      (r) => r.status?.postgres_role === identity.userName,
    );
    if (!found) {
      throw new Error(`Creating your role on ${branch} did not return it.`);
    }
    return { role: found, action: "created" };
  }
  if (existing.status?.membership_roles?.includes(SUPERUSER_MEMBERSHIP)) {
    return { role: existing, action: "kept" };
  }
  onStep(`Adding ${SUPERUSER_MEMBERSHIP} to your role ${identity.userName}`);
  const role = await api.setRoleMemberships(existing.name, [
    SUPERUSER_MEMBERSHIP,
  ]);
  return { role: role?.name ? role : existing, action: "updated" };
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

/** The profile or host init authenticated with, for a .env that names neither. */
async function authValues(
  ctx: DbContext,
  current: Record<string, string>,
): Promise<Record<string, string>> {
  if (current.DATABRICKS_CONFIG_PROFILE || current.DATABRICKS_HOST) return {};
  const profile = ctx.env.DATABRICKS_CONFIG_PROFILE;
  if (profile) return { DATABRICKS_CONFIG_PROFILE: profile };
  const host = ctx.env.DATABRICKS_HOST || (await ctx.workspace().getHost());
  return host ? { DATABRICKS_HOST: host } : {};
}

function readEnvValues(file: string): Record<string, string> {
  return fs.existsSync(file)
    ? dotenv.parse(fs.readFileSync(file, "utf-8"))
    : {};
}

/**
 * `appkit db init`: find or create your dev branch or this checkout's session
 * branch, ensure a read-write endpoint and your DATABRICKS_SUPERUSER role,
 * point `.env` at the branch, hand the app schema the fork copied to you
 * (except with `--schema none`), then start the schema. No prompts: every
 * choice has a default. It refuses the project's default branch, protected
 * branches and branches databricks.yml deploys to before changing anything,
 * and never touches the deploy bundle.
 * One lock on the checkout's history covers the whole run, so no other
 * `appkit db` command runs between its clean and migrate; `--schema none`
 * changes no history and takes none.
 */
export async function runInit(
  ctx: DbContext,
  options: InitOptions = {},
): Promise<InitReport> {
  if (options.schema === "none") return initHolding(ctx, null, options);
  // Before the lock, which creates config/database.
  if (options.schema === "migrate" || options.schema === "clean") {
    requireSchemaFile(ctx.root, options.schema);
  }
  return withHistoryLock(ctx.root, "init", (lock) =>
    initHolding(ctx, lock, options),
  );
}

async function initHolding(
  ctx: DbContext,
  lock: HistoryLock | null,
  options: InitOptions,
): Promise<InitReport> {
  const onStep = options.onStep ?? (() => undefined);
  const interactive = options.interactive ?? false;
  const ttl =
    options.ttl === undefined
      ? { api: SESSION_BRANCH_TTL, label: "7 days" }
      : { api: parseTtl(options.ttl), label: options.ttl.trim() };

  // Before any change, check the .env init may write and read the schema the
  // hand-off and the start are for. --schema none does neither, so it reads no
  // schema.ts.
  const envFile = path.join(ctx.root, ENV_FILE);
  refuseSymlink(envFile);
  const hasSchema = hasSchemaFile(ctx.root);
  const startKind = options.schema ?? (hasSchema ? "migrate" : "introspect");
  const schemaName =
    hasSchema && startKind !== "introspect" && startKind !== "none"
      ? (await loadDefaultDatabaseSchema(ctx.root, { showImportError: true }))
          .$schemaName
      : DEFAULT_SCHEMA_NAME;

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
  const mode = options.mode ?? defaultMode(local, identity.userName);
  if (options.ttl !== undefined && mode !== "session") {
    throw new Error("--ttl applies to session branches only; add --session.");
  }
  const before = readEnvValues(envFile);

  const found = await findOrCreateBranch(ctx, {
    project,
    mode,
    identity,
    session: local.session,
    ttl,
    boundary: readDeployBoundary(ctx.root),
    envFile,
    onStep,
  });
  const { branch } = found;

  const {
    endpoint,
    created: endpointCreated,
    host,
  } = await ensureReadWriteEndpoint(ctx, branch.name, onStep);
  const roles = await ctx.api().listRoles(branch.name);
  const { role, action } = await ensureDeveloperRole(
    ctx,
    branch.name,
    identity,
    roles,
    onStep,
  );
  const database = await resolveDatabase(ctx, branch.name, local, deploy);

  const values: Record<string, string> = {
    LAKEBASE_PROJECT: project,
    PGHOST: host,
    LAKEBASE_ENDPOINT: endpoint.name,
    PGDATABASE: database,
    PGUSER: identity.userName,
    ...(found.session === null ? {} : { APPKIT_DB_SESSION: found.session }),
    ...(before.PGPORT && /^\d+$/.test(before.PGPORT) ? {} : { PGPORT: "5432" }),
    ...(before.PGSSLMODE ? {} : { PGSSLMODE: "require" }),
    ...(await authValues(ctx, before)),
  };
  onStep(`Pointing .env at ${resourceId(branch.name)}, database ${database}`);
  updateEnvFile(envFile, values);
  const branchCtx: DbContext = { ...ctx, env: { ...ctx.env, ...values } };

  // --schema none leaves the schema as the fork has it, owner included.
  const handedOff =
    startKind === "none"
      ? null
      : await handOffAppSchema(branchCtx, {
          branch: branch.name,
          database,
          schemaName,
          developer: role,
          roles,
          onStep,
        });

  const installed =
    startKind === "migrate" || startKind === "introspect"
      ? ensureDrizzleKit(ctx.root, options.runCommand ?? runCommand, onStep)
      : null;

  // Without a lock (--schema none) the schema stays as the fork has it.
  let start: InitStart = { kind: "none" };
  const on = `on ${resourceId(branch.name)}`;
  if (lock && startKind === "migrate") {
    onStep(`Migrating schema ${schemaName} ${on}`);
    start = {
      kind: "migrate",
      migrate: await migrateHolding(branchCtx, lock, { interactive }),
    };
  } else if (lock && startKind === "introspect") {
    onStep(`Writing schema.ts from schema ${schemaName} ${on}`);
    start = {
      kind: "introspect",
      introspect: await introspectHolding(branchCtx, lock, { interactive }),
    };
  } else if (lock && startKind === "clean") {
    onStep(`Dropping schema ${schemaName} ${on}`);
    const clean = await cleanHolding(branchCtx, lock);
    // Recreate from the committed migrations, so the startup check passes.
    start = {
      kind: "clean",
      clean,
      migrate: await migrateHolding(branchCtx, lock, {
        interactive,
        generate: false,
      }),
    };
  }

  return {
    mode,
    branch: branch.name,
    created: found.created,
    ...(found.sourceBranch ? { sourceBranch: found.sourceBranch } : {}),
    expireTime: branch.status?.expire_time ?? null,
    endpoint: endpoint.name,
    endpointCreated,
    host,
    database,
    user: identity.userName,
    role: { name: role.name, action },
    handedOff,
    envFile,
    installed,
    start,
  };
}
