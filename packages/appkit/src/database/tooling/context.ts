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

export interface ToolingRequest {
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  payload?: unknown;
}

export interface ToolingWorkspaceClient {
  request(request: WorkspaceRequest): Promise<Response>;
  readonly currentUser: {
    me(request: { attributes?: string }): Promise<{ userName?: string }>;
  };
  getHost(): Promise<string>;
}

export interface DbContext {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  workspace(): ToolingWorkspaceClient;
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

export function profileHost(profile: string): Promise<string> {
  return createWorkspaceClient({
    profile,
    clientOptions: getClientOptions(),
  }).getHost();
}

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

export function hasEnvBranch(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.PGHOST && env.PGDATABASE && env.LAKEBASE_ENDPOINT);
}

const UNVERIFIED_SSL_MODES: ReadonlySet<string> = new Set([
  "prefer",
  "disable",
  "allow",
]);

export const CERT_VERIFYING_SSL_MODE = "require";

function verifyingSslMode(
  mode: string | undefined,
): LakebasePoolConfig["sslMode"] {
  if (mode === undefined || mode === "") return CERT_VERIFYING_SSL_MODE;
  if (UNVERIFIED_SSL_MODES.has(mode)) {
    throw new Error(
      `PGSSLMODE=${mode} does not verify the server's certificate, so it did not connect. Set PGSSLMODE to require, or unset it.`,
    );
  }
  return mode as LakebasePoolConfig["sslMode"];
}

async function openBranchPool(ctx: DbContext): Promise<Pool> {
  const { PGHOST, PGDATABASE, LAKEBASE_ENDPOINT } = ctx.env;
  if (!PGHOST || !PGDATABASE || !LAKEBASE_ENDPOINT) {
    throw new Error(`Did not connect: ${NO_ENV_BRANCH}.`);
  }
  const sslMode = verifyingSslMode(ctx.env.PGSSLMODE);
  const [user] = await Promise.all([
    ctx.env.PGUSER || currentIdentity(ctx).then(({ userName }) => userName),
    assertHostServesEndpoint(ctx, LAKEBASE_ENDPOINT, PGHOST),
  ]);
  const port = ctx.env.PGPORT ? Number(ctx.env.PGPORT) : undefined;
  return createLakebasePool({
    host: PGHOST,
    database: PGDATABASE,
    endpoint: LAKEBASE_ENDPOINT,
    user,
    ...(port ? { port } : {}),
    sslMode,
    workspaceClient: ctx.workspace(),
    max: 2,
    idleTimeoutMillis: 1_000,
  });
}

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
