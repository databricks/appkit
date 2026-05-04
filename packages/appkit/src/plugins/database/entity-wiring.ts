import { WorkspaceClient } from "@databricks/sdk-experimental";
import type { Pool } from "pg";
import { createLakebasePool } from "@/connectors";
import { ServiceContext } from "@/context";
import {
  type AppKitTable,
  createDrizzleDataPath,
  type DataPath,
  type Schema,
} from "@/database";
import { AuthenticationError, ConfigurationError } from "@/errors";
import { createLogger } from "@/logging/logger";
import {
  type EntityClient,
  type ExecutorFn,
  makeEntityClient,
} from "./entity-proxy";
import type { IDatabaseConfig } from "./types";

const logger = createLogger("database:wiring");

interface WireEntitiesArgs {
  schema: Schema;
  config: IDatabaseConfig;
  /** Service-principal pool, already created by the plugin in `setup()`. */
  servicePool: Pool;
  /** Bound `Plugin#execute` wrapper threaded into every entity. */
  executor: ExecutorFn;
}

interface WireEntitiesResult {
  entities: Record<string, EntityClient>;
  /** Service-principal DataPath. Backs `appkit.database.transaction` and `sql\`\``. */
  dataPath: DataPath;
  /** Per-user pool registry. The plugin owns its lifecycle on shutdown. */
  userPools: UserPoolRegistry;
}

/**
 * Per-user pool registry.
 *
 * `getOrCreate(identity)` returns (or builds) a `pg.Pool` whose Lakebase OAuth
 * resolves to the given user. Pools are kept in a bounded LRU keyed by email;
 * evicted pools are moved to a draining set so `closeAll()` waits for any
 * in-flight queries to finish before resolving.
 */
export interface UserPoolRegistry {
  resolveIdentity(req: import("express").Request): UserPoolIdentity | null;
  getOrCreate(identity: UserPoolIdentity): Pool;
  getOrCreateDataPath(identity: UserPoolIdentity): DataPath;
  closeAll(): Promise<void>;
}

interface UserPoolIdentity {
  email: string;
  token: string;
}

/**
 * Wire one EntityClient per table on top of the service-principal pool, plus
 * a per-user pool factory used by `EntityClient.asUser(req)` to swap identity.
 *
 * The runtime data path is `DataPath` (Drizzle behind a thin AppKit-shaped
 * interface). The wiring layer never sees Drizzle; it only constructs
 * `DataPath` instances and passes them down.
 */
export function wireEntities(args: WireEntitiesArgs): WireEntitiesResult {
  const serviceDataPath = createDrizzleDataPath(args.servicePool, args.schema);
  const userPools = makeUserPoolRegistry(args.config, args.schema);

  const makeUserDataPath = (
    req: import("express").Request,
  ): DataPath | null => {
    const identity = userPools.resolveIdentity(req);
    if (!identity) return null;
    return userPools.getOrCreateDataPath(identity);
  };

  const entities: Record<string, EntityClient> = {};
  for (const [entity, table] of Object.entries(args.schema.$tables)) {
    entities[entity] = makeEntityClient({
      entity,
      table,
      dataPath: serviceDataPath,
      pkColumn: derivePkColumn(table),
      hooks: args.config.hooks?.[entity],
      hookContext: () => ({ entity }),
      execute: args.executor,
      makeUserDataPath,
      cache: args.config.cache,
    });
  }

  logger.info(
    "Database entities wired (%d tables, runtime: drizzle/pool)",
    Object.keys(entities).length,
  );

  return { entities, dataPath: serviceDataPath, userPools };
}

/**
 * Resolve a table's primary-key column name. Falls back to the conventional
 * `"id"` when the schema has no column flagged as primary key. Composite PKs
 * are intentionally rejected at schema-builder time, so a single name is
 * always sufficient here.
 */
function derivePkColumn(table: AppKitTable): string {
  for (const [name, meta] of Object.entries(table.$columns)) {
    if (meta.primaryKey) return name;
  }
  return "id";
}

/**
 * Build the per-user pool registry. Pools are created lazily on first
 * `getOrCreate(email)` and reused across requests for the same identity.
 *
 * Each pool is constructed via `createLakebasePool({ user, workspaceClient })`,
 * where the workspace client is authenticated with the forwarded user token.
 * Lakebase OAuth refresh still happens inside the pool; this layer only selects
 * the identity and bounds the number of open pools.
 */
function makeUserPoolRegistry(
  config: IDatabaseConfig,
  schema: Schema,
): UserPoolRegistry {
  const pools = new Map<string, Pool>();
  // Pools that have been evicted but may still have in-flight queries. We hold
  // them here so `closeAll()` waits for graceful drain before returning.
  const draining = new Set<Pool>();
  const dataPaths = new WeakMap<Pool, DataPath>();
  const maxPools = normalizePoolMax(config.oboPoolMax);

  function buildDataPath(pool: Pool): DataPath {
    let dp = dataPaths.get(pool);
    if (!dp) {
      dp = createDrizzleDataPath(pool, schema);
      dataPaths.set(pool, dp);
    }
    return dp;
  }

  function getOrCreate(identity: UserPoolIdentity): Pool {
    const existing = pools.get(identity.email);
    if (existing) {
      pools.delete(identity.email);
      pools.set(identity.email, existing);
      return existing;
    }

    const pool = createLakebasePool({
      ...config.connection,
      user: identity.email,
      workspaceClient: createUserWorkspaceClient(identity.token),
    });
    // Set session-local app.user_id on every connection so RLS predicates
    // referencing current_user_id() (the helpers emitted by `appkit db rls`)
    // resolve to the OBO user. Per-user pool means the identity is invariant
    // across connections in this pool, so a session-level setting is safe.
    pool.on("connect", (client) => {
      client
        .query("SELECT set_config('app.user_id', $1, false)", [identity.email])
        .catch((err) => {
          logger.error(
            "Failed to set app.user_id on user pool connection for %s: %O",
            identity.email,
            err,
          );
        });
    });
    pools.set(identity.email, pool);
    evictOldestIfNeeded(pools, draining, maxPools);
    logger.debug("Created per-user pool for %s", identity.email);
    return pool;
  }

  return {
    resolveIdentity(req) {
      return resolveUserPoolIdentity(req);
    },
    getOrCreate,
    getOrCreateDataPath(identity) {
      return buildDataPath(getOrCreate(identity));
    },
    async closeAll() {
      const entries = Array.from(pools.entries());
      const drainingPools = Array.from(draining);
      pools.clear();
      draining.clear();
      await Promise.all([
        ...entries.map(async ([email, pool]) => {
          try {
            await pool.end();
            logger.debug("Closed per-user pool for %s", email);
          } catch (err) {
            logger.error("Error closing per-user pool for %s: %O", email, err);
          }
        }),
        ...drainingPools.map(async (pool) => {
          try {
            await pool.end();
          } catch (err) {
            logger.error("Error draining evicted per-user pool: %O", err);
          }
        }),
      ]);
    },
  };
}

function resolveUserPoolIdentity(
  req: import("express").Request,
): UserPoolIdentity | null {
  const email = req.header("x-forwarded-email");
  const token = req.header("x-forwarded-access-token");
  const isDev = process.env.NODE_ENV === "development";

  if (email && token) return { email, token };

  if (isDev) {
    logger.warn(
      "Database OBO requested without x-forwarded-email/x-forwarded-access-token; falling back to service pool in development.",
    );
    return null;
  }

  if (!token) throw AuthenticationError.missingToken("user token");
  throw new AuthenticationError(
    "Missing x-forwarded-email header. Cannot create a user-scoped database pool.",
  );
}

function createUserWorkspaceClient(token: string): WorkspaceClient {
  const host = process.env.DATABRICKS_HOST;
  if (!host) throw ConfigurationError.missingEnvVar("DATABRICKS_HOST");
  return new WorkspaceClient(
    {
      host,
      token,
      authType: "pat",
    },
    ServiceContext.getClientOptions(),
  );
}

function normalizePoolMax(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 50;
  return Math.max(1, Math.floor(value));
}

function evictOldestIfNeeded(
  pools: Map<string, Pool>,
  draining: Set<Pool>,
  maxPools: number,
): void {
  while (pools.size > maxPools) {
    const oldest = pools.entries().next().value as
      | [email: string, pool: Pool]
      | undefined;
    if (!oldest) return;
    const [email, pool] = oldest;
    pools.delete(email);
    draining.add(pool);
    pool
      .end()
      .catch((err) => {
        logger.error("Error evicting per-user pool for %s: %O", email, err);
      })
      .finally(() => {
        draining.delete(pool);
      });
    logger.debug("Evicted per-user pool for %s", email);
  }
}
