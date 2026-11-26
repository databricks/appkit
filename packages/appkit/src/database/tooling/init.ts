import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import type { PoolClient } from "pg";

import { DEFAULT_SCHEMA_FILE } from "../../plugins/database/load-schema";
import { loadDatabaseSchema } from "../../type-generator/database";
import { DEFAULT_SCHEMA_NAME } from "../schema-builder/define-schema";
import { type CleanReport, cleanHolding } from "./clean";
import {
  CERT_VERIFYING_SSL_MODE,
  type DbContext,
  withBranchPool,
} from "./context";
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
import {
  introspectHolding,
  type IntrospectOptions,
  type IntrospectReport,
  IntrospectRefusedError,
} from "./introspect";
import { shown } from "./introspect/render";
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
  isUsersSessionBranchId,
  newSessionId,
  parseTtl,
  SESSION_BRANCH_TTL,
  sessionBranchId,
} from "./naming";
import {
  planStart,
  readSchemaState,
  type SchemaStart,
  type SchemaState,
  type StartPlan,
  tagForkCopy,
  untagForkCopy,
} from "./schema-state";
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

export type { SchemaStart } from "./schema-state";

export interface InitOptions {
  readonly mode?: BranchMode;
  readonly schema?: SchemaStart;
  readonly confirmClean?: (target: {
    readonly branch: string;
    readonly schemaName: string;
  }) => Promise<boolean>;
  readonly ttl?: string;
  readonly interactive?: boolean;
  readonly onStep?: (message: string) => void;
  readonly onWarning?: (message: string) => void;
  readonly runCommand?: RunCommand;
}

type RoleAction = "kept" | "created" | "updated";

type RebuildReason = "fork-copy" | "requested";

interface Rebuild {
  readonly clean: CleanReport;
  readonly migrate: MigrateReport;
  readonly reason: RebuildReason;
}

export type InitStart =
  | { readonly kind: "none" }
  | { readonly kind: "cancelled"; readonly schemaName: string }
  | { readonly kind: "migrate"; readonly migrate: MigrateReport }
  | {
      readonly kind: "introspect";
      readonly introspect: IntrospectReport;
      readonly rebuilt: Rebuild | null;
    }
  | ({ readonly kind: "clean" } & Rebuild);

export type KeptCopy =
  | { readonly reason: "requested"; readonly from: string | null }
  | { readonly reason: "public"; readonly objects: readonly string[] };

export interface InitReport {
  readonly mode: BranchMode;
  readonly branch: string;
  readonly created: boolean;
  readonly sourceBranch?: string;
  readonly expireTime: string | null;
  readonly endpoint: string;
  readonly endpointCreated: boolean;
  readonly host: string;
  readonly database: string;
  readonly user: string;
  readonly role: { readonly name: string; readonly action: RoleAction };
  readonly handedOff: string | null;
  readonly keptCopy: KeptCopy | null;
  readonly envFile: string;
  readonly installed: string | null;
  readonly start: InitStart;
}

const ENV_FILE = ".env";
const DEFAULT_ENDPOINT_ID = "primary";
/** An idle compute counts against the project's 20 active ones. */
const SUSPEND_TIMEOUT = "300s";
const ENDPOINT_HOST_WAIT = { intervalMs: 2_000, timeoutMs: 90_000 };
const DEFAULT_DATABASE = "databricks_postgres";

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

async function defaultMode(
  ctx: DbContext,
  project: string,
  local: LocalTarget,
  userName: string,
): Promise<BranchMode> {
  if (!local.session) return "dev";
  const branch = parseResourceName(local.endpoint ?? undefined)?.branch;
  const id = branch ? resourceId(branch) : null;
  if (id && isUsersSessionBranchId(userName, id)) return "session";
  if (id === devBranchId(userName)) return "dev";
  const stopped = await ctx
    .api()
    .getBranch(
      `${project}/branches/${sessionBranchId(userName, local.session)}`,
    );
  return stopped && !isGone(stopped) ? "session" : "dev";
}

function withSessionRerun(error: unknown): unknown {
  if (error instanceof Error) {
    error.message = error.message.replace(
      /([Rr]erun `appkit db init)(?! --session)/g,
      "$1 --session",
    );
  }
  return error;
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
  readonly ttl: { readonly api: string; readonly label: string };
  readonly boundary: DeployBoundary;
  readonly envFile: string;
  readonly deploy: DeployTarget | null;
  readonly onStep: (message: string) => void;
}

type FoundBranch = {
  readonly branch: LakebaseBranch;
  readonly session: string | null;
} & (
  | { readonly created: false }
  | {
      readonly created: true;
      readonly sourceBranch: string;
      readonly boundDatabase: string | null;
    }
);

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

const INIT_SETS_UP =
  "`appkit db init` only sets up your dev branch or this checkout's session branch";

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
    const deployed = branches.find(
      (b) => b.name === request.deploy?.branch && !isGone(b),
    );
    const parent = deployed ?? branches.find((b) => b.status?.default);
    if (!parent) {
      throw new Error(`Project ${project} has no default branch to fork from.`);
    }
    const boundDatabase = await readBoundDatabase(
      ctx,
      parent.name,
      request.deploy,
      name,
    );
    persistSessionIdBeforeFork(request, session);
    onStep(
      `Creating ${resourceId(name)} from ${resourceId(parent.name)} (${deployed ? "the branch databricks.yml deploys to" : "the project's default branch"})${session === null ? "" : `, expiring after ${request.ttl.label}`}`,
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
        boundDatabase,
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
      const raced = await api.getBranch(name);
      if (raced && !isGone(raced)) return reuse(raced);
      replaceGone(name);
    }
  }
}

function persistSessionIdBeforeFork(
  request: BranchRequest,
  session: string | null,
): void {
  if (session !== null && session !== request.session) {
    updateEnvFile(request.envFile, { APPKIT_DB_SESSION: session });
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    try {
      endpoint = await api.createEndpoint(branch, DEFAULT_ENDPOINT_ID, {
        suspendTimeout: SUSPEND_TIMEOUT,
      });
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      endpoint = readWrite(await api.listEndpoints(branch));
      if (!endpoint) {
        throw new Error(
          `Endpoint ${DEFAULT_ENDPOINT_ID} on ${branch} exists but is not a read-write endpoint, so init cannot use it. Create a read-write endpoint on the branch, then rerun \`appkit db init\`.`,
          { cause: error },
        );
      }
    }
  }
  const deadline = Date.now() + ENDPOINT_HOST_WAIT.timeoutMs;
  let waiting = false;
  while (!endpoint?.status?.hosts?.host && Date.now() < deadline) {
    if (!waiting) {
      waiting = true;
      onStep(
        `Waiting for the read-write endpoint of ${resourceId(branch)} to get a host`,
      );
    }
    await sleep(ENDPOINT_HOST_WAIT.intervalMs);
    endpoint = readWrite(await api.listEndpoints(branch)) ?? endpoint;
  }
  const host = endpoint?.status?.hosts?.host;
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
  const mine = (list: readonly LakebaseRole[]) =>
    list.find((r) => r.status?.postgres_role === identity.userName);

  let existing = mine(roles);
  if (!existing) {
    onStep(
      `Creating your role ${identity.userName} with ${SUPERUSER_MEMBERSHIP}`,
    );
    let created: LakebaseRole | undefined;
    try {
      created = await api.createRole(branch, {
        identity_type: identity.identityType,
        postgres_role: identity.userName,
        auth_method: "LAKEBASE_OAUTH_V1",
        membership_roles: [SUPERUSER_MEMBERSHIP],
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    if (created?.name) return { role: created, action: "created" };
    existing = mine(await api.listRoles(branch));
    if (!existing) {
      throw new Error(
        `Creating your role on ${branch} did not return it, and listing the branch's roles did not find it. Rerun \`appkit db init\`.`,
      );
    }
    if (created) return { role: existing, action: "created" };
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

async function readBoundDatabase(
  ctx: DbContext,
  branch: string,
  deploy: DeployTarget | null,
  forking?: string,
): Promise<string | null> {
  if (!deploy?.database) return null;
  const id = resourceId(deploy.database);
  const database = await ctx.api().getDatabase(`${branch}/databases/${id}`);
  if (!database) {
    const where = forking
      ? `${resourceId(branch)}, the branch ${resourceId(forking)} would fork from, so init created nothing`
      : resourceId(branch);
    throw new Error(
      `Database ${id}, which databricks.yml binds, is not on ${where}. Create it there (databricks postgres create-database ${branch} --database-id ${id}), or bind a database the project's branches have, then rerun \`appkit db init\`.`,
    );
  }
  if (!database.status?.postgres_database) {
    throw new Error(
      `Lakebase returned database ${id} on ${resourceId(branch)} without its Postgres database name. Rerun \`appkit db init\` in a minute.`,
    );
  }
  return database.status.postgres_database;
}

function chooseDatabase(
  bound: string | null,
  local: LocalTarget,
  onWarning: (message: string) => void,
): string {
  if (bound === null) return local.database ?? DEFAULT_DATABASE;
  if (local.database && local.database !== bound) {
    onWarning(
      `Setting PGDATABASE=${shown(bound)} in .env: it was ${shown(local.database)}, and databricks.yml binds ${shown(bound)}`,
    );
  }
  return bound;
}

const SCHEMA_NAME_ADVICE = "Pass --schema-name <name> to read another schema.";

async function introspectForInit(
  ctx: DbContext,
  lock: HistoryLock,
  options: IntrospectOptions,
): Promise<IntrospectReport> {
  try {
    return await introspectHolding(ctx, lock, options);
  } catch (error) {
    if (
      !(error instanceof IntrospectRefusedError) ||
      !error.message.includes(SCHEMA_NAME_ADVICE)
    ) {
      throw error;
    }
    throw new IntrospectRefusedError(
      error.message.replace(
        SCHEMA_NAME_ADVICE,
        "Run `appkit db introspect --schema-name <name>` to read another schema.",
      ),
      { cause: error },
    );
  }
}

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

export async function runInit(
  ctx: DbContext,
  options: InitOptions = {},
): Promise<InitReport> {
  const requested = options.schema;
  if (requested === "none") return initHolding(ctx, { kind: "none" }, options);
  if (requested === "migrate" || requested === "clean") {
    requireSchemaFile(ctx.root, requested);
  }
  return withHistoryLock(ctx.root, "init", (lock) =>
    initHolding(ctx, { kind: "locked", lock, requested }, options),
  );
}

type StartRequest =
  | { readonly kind: "none" }
  | {
      readonly kind: "locked";
      readonly lock: HistoryLock;
      readonly requested: Exclude<SchemaStart, "none"> | undefined;
    };

async function initHolding(
  ctx: DbContext,
  request: StartRequest,
  options: InitOptions,
): Promise<InitReport> {
  const onStep = options.onStep ?? (() => undefined);
  const onWarning = options.onWarning ?? onStep;
  const interactive = options.interactive ?? false;
  const ttl =
    options.ttl === undefined
      ? { api: SESSION_BRANCH_TTL, label: "7 days" }
      : { api: parseTtl(options.ttl), label: options.ttl.trim() };

  const envFile = path.join(ctx.root, ENV_FILE);
  refuseSymlink(envFile);
  const hasSchema = hasSchemaFile(ctx.root);
  const schemaName =
    hasSchema && request.kind === "locked"
      ? (
          await loadDatabaseSchema(path.join(ctx.root, DEFAULT_SCHEMA_FILE), {
            keepImportErrorAsCause: true,
          })
        ).$schemaName
      : DEFAULT_SCHEMA_NAME;

  const configured = {
    local: readLocalTarget(ctx.env),
    deploy: readDeployTarget(ctx.root, ctx.env),
  };
  const project = resolveProject(configured.local, configured.deploy);
  const { local, deploy } = scopeToProject(
    project,
    configured.local,
    configured.deploy,
  );
  const identity = await currentIdentity(ctx);
  const mode =
    options.mode ?? (await defaultMode(ctx, project, local, identity.userName));
  if (options.ttl !== undefined && mode !== "session") {
    throw new Error("--ttl applies to session branches only; add --session.");
  }
  try {
    const before = readEnvValues(envFile);

    const found = await findOrCreateBranch(ctx, {
      project,
      mode,
      identity,
      session: local.session,
      ttl,
      boundary: readDeployBoundary(ctx.root, ctx.env),
      envFile,
      deploy,
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
    const database = chooseDatabase(
      found.created
        ? found.boundDatabase
        : await readBoundDatabase(ctx, branch.name, deploy),
      local,
      onWarning,
    );

    const values: Record<string, string> = {
      LAKEBASE_PROJECT: project,
      PGHOST: host,
      LAKEBASE_ENDPOINT: endpoint.name,
      PGDATABASE: database,
      PGUSER: identity.userName,
      ...(found.session === null ? {} : { APPKIT_DB_SESSION: found.session }),
      ...(before.PGPORT && /^\d+$/.test(before.PGPORT)
        ? {}
        : { PGPORT: "5432" }),
      ...(before.PGSSLMODE === CERT_VERIFYING_SSL_MODE
        ? {}
        : { PGSSLMODE: CERT_VERIFYING_SSL_MODE }),
      ...(await authValues(ctx, before)),
    };
    if (before.PGSSLMODE && before.PGSSLMODE !== CERT_VERIFYING_SSL_MODE) {
      onStep(
        `Setting PGSSLMODE=${CERT_VERIFYING_SSL_MODE} in .env: it was ${before.PGSSLMODE}, and only ${CERT_VERIFYING_SSL_MODE} makes every connection use TLS and check the server's certificate`,
      );
    }
    onStep(
      `Pointing .env at ${resourceId(branch.name)}, database ${shown(database)}`,
    );
    updateEnvFile(envFile, values);
    const branchCtx: DbContext = { ...ctx, env: { ...ctx.env, ...values } };

    const base = {
      mode,
      branch: branch.name,
      created: found.created,
      ...(found.created ? { sourceBranch: found.sourceBranch } : {}),
      expireTime: branch.status?.expire_time ?? null,
      endpoint: endpoint.name,
      endpointCreated,
      host,
      database: shown(database),
      user: identity.userName,
      role: { name: role.name, action },
      envFile,
    };
    if (request.kind === "none") {
      return {
        ...base,
        handedOff: null,
        keptCopy: null,
        installed: null,
        start: { kind: "none" },
      };
    }
    const { lock, requested } = request;

    const state = await withBranchPool(branchCtx, (pool) =>
      readSchemaState(pool, schemaName),
    );
    const plan = planStart(state, requested, hasSchema, found.created);
    const on = `on ${resourceId(branch.name)}`;
    if (
      plan.confirm &&
      options.confirmClean &&
      !(await options.confirmClean({ branch: branch.name, schemaName }))
    ) {
      return {
        ...base,
        handedOff: null,
        keptCopy: null,
        installed: null,
        start: { kind: "cancelled", schemaName },
      };
    }
    const onBranch = <T>(
      work: (client: Pick<PoolClient, "query">) => Promise<T>,
    ) => withBranchPool(branchCtx, work);
    if (
      plan.tag &&
      !(await onBranch((client) => tagForkCopy(client, schemaName)))
    ) {
      onWarning(
        `Could not mark schema ${schemaName} ${on} as the fork's copy. It has no journal table, or one owned by a role init does not trust. If this run stops before the rebuild finishes, the next \`appkit db init\` will see a schema that looks like your working branch and keep the copied rows. Run \`appkit db init --schema clean\` then.`,
      );
    }
    const installed = ensureDrizzleKit(
      ctx.root,
      options.runCommand ?? runCommand,
      onStep,
    );

    const introspect = (recordAsApplied: boolean) => {
      onStep(`Writing schema.ts from schema ${schemaName} ${on}`);
      return introspectForInit(branchCtx, lock, {
        interactive,
        schemaName,
        recordAsApplied,
      });
    };
    let introspected: IntrospectReport | null = null;
    if (plan.kind === "introspect" && plan.rebuild) {
      introspected = await introspect(false);
    }

    const handedOff = plan.handOff
      ? await handOffAppSchema(branchCtx, {
          branch: branch.name,
          database,
          schemaName,
          developer: role,
          roles,
          onStep,
        })
      : null;
    if (plan.keepsCopy) {
      await onBranch((client) => untagForkCopy(client, schemaName));
    }

    const rebuildSchema = async (): Promise<Rebuild> => {
      const reason: RebuildReason =
        requested === undefined ? "fork-copy" : "requested";
      const why =
        reason === "fork-copy"
          ? ": the branch still holds the rows the fork copied, and the committed migrations recreate its tables"
          : "";
      onStep(
        schemaName === "public"
          ? `Removing your objects in schema public ${on}${why}`
          : `Dropping schema ${schemaName} ${on}${why}`,
      );
      const clean = await cleanHolding(branchCtx, lock);
      const migrate = await migrateHolding(branchCtx, lock, {
        interactive,
        generate: false,
      });
      return { clean, migrate, reason };
    };
    let start: InitStart;
    if (plan.kind === "migrate") {
      onStep(`Migrating schema ${schemaName} ${on}`);
      start = {
        kind: "migrate",
        migrate: await migrateHolding(branchCtx, lock, { interactive }),
      };
    } else if (plan.kind === "introspect") {
      start = {
        kind: "introspect",
        introspect: introspected ?? (await introspect(true)),
        rebuilt: plan.rebuild ? await rebuildSchema() : null,
      };
    } else {
      start = { kind: "clean", ...(await rebuildSchema()) };
    }

    return {
      ...base,
      handedOff,
      keptCopy: keptCopyOf(
        state,
        plan,
        found.created
          ? found.sourceBranch
          : (branch.status?.source_branch ?? null),
      ),
      installed,
      start,
    };
  } catch (error) {
    throw mode === "session" ? withSessionRerun(error) : error;
  }
}

function keptCopyOf(
  state: SchemaState,
  plan: StartPlan,
  source: string | null,
): KeptCopy | null {
  if (plan.keepsCopy) return { reason: "requested", from: source };
  if (state.kind === "public" && !plan.rebuild && state.kept.length > 0) {
    return { reason: "public", objects: state.kept };
  }
  return null;
}
