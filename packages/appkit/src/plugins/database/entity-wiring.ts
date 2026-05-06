import { createHash } from "node:crypto";
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
  APPLICATION_NAME,
  DEFAULT_RLS_SESSION_VARIABLE,
  OBO_POOL_DEFAULTS,
  STATEMENT_TIMEOUT_DEFAULT_MS,
} from "./defaults";
import {
  type EntityClient,
  type ExecutorFn,
  makeEntityClient,
  normalizeOboEmail,
} from "./entity-proxy";
import type { IDatabaseConfig } from "./types";

/**
 * Hashed log tag — keeps per-user lines correlatable without logging the raw
 * email (PII). Format: `<first-3-chars>#<sha256(email)[:8]>`.
 */
function logTagForEmail(email: string): string {
  const lower = email.toLowerCase();
  const visible = lower.slice(0, Math.min(lower.length, 3));
  const digest = createHash("sha256").update(lower).digest("hex").slice(0, 8);
  return `${visible}#${digest}`;
}

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
 * Per-user pool registry. `getOrCreate(identity)` returns a `pg.Pool` whose
 * Lakebase OAuth resolves to the given user. Bounded LRU keyed by email;
 * evicted pools drain in the background so `closeAll()` awaits in-flight queries.
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
 * Wire one EntityClient per table on the SP pool, plus a per-user pool factory
 * for `EntityClient.asUser(req)`. Wiring never touches Drizzle — only
 * `DataPath` instances flow through.
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

  // Plugin's `setup()` already logs the boot summary; don't duplicate.
  return { entities, dataPath: serviceDataPath, userPools };
}

/**
 * Resolve PK column name; defaults to `"id"`. Composite PKs are rejected at
 * schema-builder time, so a single name always suffices.
 */
function derivePkColumn(table: AppKitTable): string {
  for (const [name, meta] of Object.entries(table.$columns)) {
    if (meta.primaryKey) return name;
  }
  return "id";
}

/**
 * Per-user pool registry. Lazy create on first `getOrCreate(email)`, reused
 * for the same identity. Built via `createLakebasePool` with a workspace
 * client bound to the forwarded user token; OAuth refresh happens inside
 * the pool. This layer only selects identity and bounds open-pool count.
 */
function makeUserPoolRegistry(
  config: IDatabaseConfig,
  schema: Schema,
): UserPoolRegistry {
  const pools = new Map<string, Pool>();
  // Evicted pools held here so `closeAll()` awaits graceful drain.
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
    const key = identity.email.toLowerCase();
    const tag = logTagForEmail(identity.email);
    const existing = pools.get(key);
    if (existing) {
      pools.delete(key);
      pools.set(key, existing);
      return existing;
    }

    // Small per-user pool (default max=4); `config.connection` overrides win.
    const pool = createLakebasePool({
      ...OBO_POOL_DEFAULTS,
      ...config.connection,
      user: identity.email,
      workspaceClient: createUserWorkspaceClient(identity.token),
    });
    // Session-local GUC so RLS helpers resolve to the OBO user — safe at
    // session scope since identity is invariant in this per-user pool.
    // `statement_timeout` set here too so OBO matches SP server-side cap.
    const statementTimeoutMs =
      config.statementTimeoutMs ?? STATEMENT_TIMEOUT_DEFAULT_MS;
    const sessionVariable =
      config.rls?.sessionVariable ?? DEFAULT_RLS_SESSION_VARIABLE;
    pool.on("connect", (client) => {
      client
        .query(`SET application_name = '${APPLICATION_NAME}:obo'`)
        .catch((err) => {
          logger.error(
            "Failed to set application_name on user pool connection for %s: %O",
            tag,
            err,
          );
        });
      client
        .query("SELECT set_config($1, $2, false)", [
          sessionVariable,
          identity.email,
        ])
        .catch((err) => {
          logger.error(
            "Failed to set %s on user pool connection for %s: %O",
            sessionVariable,
            tag,
            err,
          );
        });
      if (Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0) {
        client
          .query(`SET statement_timeout = ${Math.floor(statementTimeoutMs)}`)
          .catch((err) => {
            logger.error(
              "Failed to set statement_timeout on user pool connection for %s: %O",
              tag,
              err,
            );
          });
      }
    });
    pools.set(key, pool);
    evictOldestIfNeeded(pools, draining, maxPools);
    logger.debug("Created per-user pool for %s", tag);
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
          const tag = logTagForEmail(email);
          try {
            await pool.end();
            logger.debug("Closed per-user pool for %s", tag);
          } catch (err) {
            logger.error("Error closing per-user pool for %s: %O", tag, err);
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
  const isDev = process.env.NODE_ENV === "development";
  const email = normalizeOboEmail(req.header("x-forwarded-email"));
  const token = req.header("x-forwarded-access-token");

  if (email && token) return { email, token };

  if (isDev) {
    logger.debug(
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
  // Default 100 active users per instance before LRU evicts; with
  // OBO_POOL_DEFAULTS.max=2, fan-out is (1+100)×2 + SP(10) ≈ 212 conns.
  // Sized for 1+ CU Lakebase tiers; tune up for hot OBO, down for 0.5 CU.
  if (!Number.isFinite(value) || value === undefined) return 100;
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
    const tag = logTagForEmail(email);
    pools.delete(email);
    draining.add(pool);
    pool
      .end()
      .catch((err) => {
        logger.error("Error evicting per-user pool for %s: %O", tag, err);
      })
      .finally(() => {
        draining.delete(pool);
      });
    logger.debug("Evicted per-user pool for %s", tag);
  }
}
