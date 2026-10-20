import type { LakebasePoolConfig } from "@databricks/lakebase";
import type { Pool } from "pg";

import { createLakebasePool } from "../../connectors/lakebase";
import { endpointHosts } from "../../connectors/lakebase/endpoint-host";
import { getClientOptions } from "../../context/client-options";
import {
  createWorkspaceClient,
  type WorkspaceRequest,
} from "../../workspace-client";
import { currentIdentity } from "./identity";
import { LakebaseApi, type LakebaseEndpoint } from "./lakebase-api";

/** One Lakebase REST call, before LakebaseApi encodes it as a workspace request. */
export interface ToolingRequest {
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  payload?: unknown;
}

/**
 * The slice of AppKit's workspace client the tooling uses. It is also all the
 * Lakebase pool needs, since token refresh goes through `request`.
 */
export interface ToolingWorkspaceClient {
  request(request: WorkspaceRequest): Promise<Response>;
  readonly currentUser: {
    me(request: { attributes?: string }): Promise<{ userName?: string }>;
  };
  /** The resolved workspace host, which init writes to a new .env. */
  getHost(): Promise<string>;
}

/** Where a command runs: the app root, its environment and its Databricks identity. */
export interface DbContext {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  /** Lazy; the profile comes from DATABRICKS_CONFIG_PROFILE. */
  workspace(): ToolingWorkspaceClient;
  /** Lazy Lakebase REST client over workspace(). */
  api(): LakebaseApi;
}

export function createDbContext(
  options: { root?: string; env?: NodeJS.ProcessEnv } = {},
): DbContext {
  const root = options.root ?? process.cwd();
  const env = options.env ?? process.env;
  let client: ToolingWorkspaceClient | undefined;
  let api: LakebaseApi | undefined;
  const ctx: DbContext = {
    root,
    env,
    workspace() {
      if (!client) {
        const profile = env.DATABRICKS_CONFIG_PROFILE;
        client = createWorkspaceClient({
          ...(profile ? { profile } : {}),
          clientOptions: getClientOptions(),
        });
      }
      return client;
    },
    api() {
      api ??= new LakebaseApi(ctx.workspace());
      return api;
    },
  };
  return ctx;
}

/**
 * The guard checks the branch named by LAKEBASE_ENDPOINT, but the pool connects
 * to PGHOST. The runtime only warns when it cannot verify that PGHOST serves that
 * endpoint; a command that writes refuses instead.
 */
async function assertHostServesEndpoint(
  ctx: DbContext,
  endpoint: string,
  host: string,
): Promise<void> {
  let found: LakebaseEndpoint | null;
  try {
    found = await ctx.api().getEndpoint(endpoint);
  } catch (error) {
    throw new Error(
      `Could not verify that PGHOST ${host} serves LAKEBASE_ENDPOINT ${endpoint}, so it did not connect.`,
      { cause: error },
    );
  }
  if (!found) {
    throw new Error(
      `LAKEBASE_ENDPOINT ${endpoint} does not exist, so it did not connect. Run \`appkit db init\` to point .env at your branch.`,
    );
  }
  const hosts = endpointHosts(found);
  if (!hosts.includes(host.toLowerCase())) {
    throw new Error(
      `PGHOST ${host} is not a host of LAKEBASE_ENDPOINT ${endpoint} (${hosts.length > 0 ? `expected ${hosts.join(" or ")}` : "it has no hosts"}), so it did not connect. Run \`appkit db init\` to rewrite .env.`,
    );
  }
}

export const NO_ENV_BRANCH =
  "no branch is configured in .env (PGHOST, PGDATABASE and LAKEBASE_ENDPOINT); run `appkit db init`";

/** Whether .env names a branch to connect to. */
export function hasEnvBranch(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.PGHOST && env.PGDATABASE && env.LAKEBASE_ENDPOINT);
}

/**
 * The pool is created directly: initializeLakebasePool would look the endpoint
 * and the user up a second time.
 */
async function openBranchPool(ctx: DbContext): Promise<Pool> {
  const { PGHOST, PGDATABASE, LAKEBASE_ENDPOINT } = ctx.env;
  if (!PGHOST || !PGDATABASE || !LAKEBASE_ENDPOINT) {
    throw new Error(`Did not connect: ${NO_ENV_BRANCH}.`);
  }
  const [user] = await Promise.all([
    ctx.env.PGUSER || currentIdentity(ctx).then(({ userName }) => userName),
    assertHostServesEndpoint(ctx, LAKEBASE_ENDPOINT, PGHOST),
  ]);
  const port = ctx.env.PGPORT ? Number(ctx.env.PGPORT) : undefined;
  const sslMode = ctx.env.PGSSLMODE as LakebasePoolConfig["sslMode"];
  return createLakebasePool({
    host: PGHOST,
    database: PGDATABASE,
    endpoint: LAKEBASE_ENDPOINT,
    user,
    ...(port ? { port } : {}),
    ...(sslMode ? { sslMode } : {}),
    workspaceClient: ctx.workspace(),
    // One-shot CLI pools: a small cap, and no lingering idle connections.
    max: 2,
    idleTimeoutMillis: 1_000,
  });
}

/** Run fn with a pool on the .env branch, and close the pool after. */
export async function withBranchPool<T>(
  ctx: DbContext,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = await openBranchPool(ctx);
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}
