import type { Pool } from "pg";
import {
  type AppKitTable,
  createDrizzleDataPath,
  createUserScopedDataPath,
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
}

/**
 * Wire one EntityClient per table on top of the service-principal pool, plus
 * a per-request user-scoped `DataPath` factory used by `EntityClient.asUser(req)`
 * to swap identity for OBO operations.
 *
 * The runtime data path is `DataPath` (Drizzle behind a thin AppKit-shaped
 * interface). Identity propagation for OBO uses `SET LOCAL app.user_id`
 * inside a transaction on the same SP pool — no per-user pool, no per-user
 * OAuth refresh, no LRU eviction.
 */
export function wireEntities(args: WireEntitiesArgs): WireEntitiesResult {
  const serviceDataPath = createDrizzleDataPath(args.servicePool, args.schema);

  const makeUserDataPath = (
    req: import("express").Request,
  ): DataPath | null => {
    const email = req.header("x-forwarded-email");
    if (!email) return null;
    return createUserScopedDataPath(args.servicePool, args.schema, {
      userId: email,
    });
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

  return { entities };
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
