import type { Pool } from "pg";
import { createLakebasePool } from "@/connectors";
import {
  type AppKitTable,
  createDrizzleDataPath,
  type DataPath,
  type Schema,
} from "@/database";
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
 * `getOrCreate(email)` returns (or builds) a `pg.Pool` whose Lakebase OAuth
 * resolves to the given user. Pools are kept in a Map; `closeAll()` drains
 * them at shutdown. There is no LRU eviction yet — for MVP, we accept a pool
 * per distinct user identity. A bounded LRU is tracked as a follow-up.
 */
export interface UserPoolRegistry {
  getOrCreate(email: string): Pool;
  closeAll(): Promise<void>;
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
    const email = req.header("x-forwarded-email");
    if (!email) return null;
    const pool = userPools.getOrCreate(email);
    return createDrizzleDataPath(pool, args.schema);
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
 * Each pool is constructed via `createLakebasePool({ user })`, which is the
 * same path the standalone `lakebase` plugin uses — Lakebase OAuth refresh
 * happens automatically inside the pool. Dev = user OAuth, prod = SP-on-behalf
 * (the platform forwards the user identity in a header, then we use Lakebase's
 * standard token exchange).
 */
function makeUserPoolRegistry(
  config: IDatabaseConfig,
  _schema: Schema,
): UserPoolRegistry {
  const pools = new Map<string, Pool>();

  return {
    getOrCreate(email) {
      const existing = pools.get(email);
      if (existing) return existing;

      const pool = createLakebasePool({
        ...config.connection,
        user: email,
      });
      pools.set(email, pool);
      logger.debug("Created per-user pool for %s", email);
      return pool;
    },
    async closeAll() {
      const entries = Array.from(pools.entries());
      pools.clear();
      await Promise.all(
        entries.map(async ([email, pool]) => {
          try {
            await pool.end();
            logger.debug("Closed per-user pool for %s", email);
          } catch (err) {
            logger.error("Error closing per-user pool for %s: %O", email, err);
          }
        }),
      );
    },
  };
}
