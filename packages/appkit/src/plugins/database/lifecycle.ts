import { createLakebasePool } from "../../connectors/lakebase";
import {
  classifyDatabaseError,
  DatabasePluginError,
} from "../../database/errors";
import type { DataPath } from "../../database/runtime";
import {
  createDrizzleDataPath,
  createDrizzleDb,
} from "../../database/runtime/engine/drizzle-data-path";
import type { Schema } from "../../database/schema-builder";
import { assertFinalizedSchema } from "../../database/schema-builder/define-schema";
import { DatabaseValidationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { STATEMENT_TIMEOUT_MS, TRANSACTION_TIMEOUT_MS } from "./defaults";
import { EntityClient, type EntityExecute } from "./entity-client";
import type {
  DatabaseExports,
  SqlTag,
  TransactionClient,
} from "./entity-types";
import { createMutationScope, type MutationScope } from "./scope";
import type { DatabaseHooks } from "./types";

const logger = createLogger("database");

/** Resources owned by one successfully initialized plugin instance. */
export interface DatabaseState {
  readonly pool: ReturnType<typeof createLakebasePool>;
  readonly exports: DatabaseExports;
  readonly deactivate: () => void;
}

interface ExportContext {
  readonly schema: Schema;
  readonly getDataPath: () => DataPath;
  readonly execute: EntityExecute;
  readonly assertActive: () => void;
  readonly scope: MutationScope;
  readonly hooks?: DatabaseHooks;
  readonly transactionBound: boolean;
}

/** Execute value-only SQL on the bound DataPath without per-statement retries. */
function buildSql(context: ExportContext): SqlTag {
  return async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    try {
      context.assertActive();
      if (context.transactionBound) {
        context.scope.consumeTransactionOperation();
      }
      // DataPath accepts value interpolation only and keeps Drizzle private.
      return await context.getDataPath().raw<T>(strings, ...values);
    } catch (error) {
      throw classifyDatabaseError(error, "read");
    }
  };
}

/** Build entities and SQL bound to either the root pool or one transaction. */
function buildTransactionClient(context: ExportContext): TransactionClient {
  const result: Record<string, unknown> = Object.create(null);
  for (const [name, table] of Object.entries(context.schema.$tables)) {
    result[name] = new EntityClient({
      table,
      getDataPath: context.getDataPath,
      execute: context.execute,
      assertActive: context.assertActive,
      scope: context.scope,
      hooks: context.hooks?.[name],
      transactionBound: context.transactionBound,
      runInTransaction: (run) =>
        runTransaction(context, (tx) => run(entityOf(tx, name))),
    });
  }
  result.sql = buildSql(context);
  return result as TransactionClient;
}

/** Typegen owns the entity keys, so reaching one by table name stays dynamic. */
function entityOf(tx: TransactionClient, name: string): EntityClient {
  return (tx as unknown as Record<string, EntityClient>)[name];
}

/** Reject from inside the driver callback so the driver rolls back on expiry. */
function runWithTransactionDeadline<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DatabasePluginError("TRANSIENT", "transaction")),
      TRANSACTION_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(run), deadline]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Run inside one transaction, joining the active one rather than nesting:
 * PostgreSQL has no nested transaction, and a savepoint would let part of a
 * hooked mutation survive a rollback.
 */
function runTransaction<T>(
  context: ExportContext,
  callback: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  context.assertActive();
  const active = context.scope.activeTransaction();
  if (active) return callback(active);
  return context.getDataPath().transaction(async (txDataPath) => {
    let open = true;
    const assertTransactionActive = () => {
      context.assertActive();
      if (!open) throw new DatabasePluginError("INTERNAL", "transaction");
    };
    // The outer transaction owns execution; inner clients use its connection.
    const directExecute: EntityExecute = async (operation) => ({
      ok: true,
      data: await operation(),
    });
    const tx = buildTransactionClient({
      ...context,
      getDataPath: () => txDataPath,
      execute: directExecute,
      assertActive: assertTransactionActive,
      transactionBound: true,
    });
    try {
      return await runWithTransactionDeadline(() =>
        context.scope.runWithTransaction(tx, () => callback(tx)),
      );
    } finally {
      // Captured clients must not outlive the transaction callback.
      open = false;
    }
  });
}

/** Add the transaction entry point to the root database surface. */
function buildDatabaseExports(context: ExportContext): DatabaseExports {
  const result = buildTransactionClient(context) as DatabaseExports;
  result.transaction = async <T>(
    callback: (tx: TransactionClient) => Promise<T>,
  ) => {
    try {
      return await runTransaction(context, callback);
    } catch (error) {
      if (error instanceof DatabaseValidationError) throw error;
      throw classifyDatabaseError(error, "transaction");
    }
  };
  return result;
}

/** Validate the schema, create one pool-backed API, and verify connectivity. */
export async function createDatabaseState<TSchema extends Schema>(
  schema: TSchema,
  execute: EntityExecute,
  hooks?: DatabaseHooks,
): Promise<DatabaseState> {
  try {
    assertFinalizedSchema(schema);
  } catch (error) {
    logger.error("Database schema failed validation: %O", error);
    throw new DatabasePluginError("SETUP_FAILED", "setup");
  }

  let active = true;
  let pool: ReturnType<typeof createLakebasePool> | undefined;
  const assertActive = () => {
    if (!active) throw new DatabasePluginError("INTERNAL", "runtime");
  };
  try {
    pool = createLakebasePool({ statement_timeout: STATEMENT_TIMEOUT_MS });
    const db = createDrizzleDb(pool, schema);
    const dataPath = createDrizzleDataPath(db, schema, {
      columnAccess: "trusted",
    });
    const exports = buildDatabaseExports({
      schema,
      getDataPath: () => dataPath,
      execute,
      assertActive,
      // One scope per state keeps concurrent instances from sharing a transaction.
      scope: createMutationScope(),
      hooks,
      transactionBound: false,
    });
    // Do not publish exports until an authenticated statement succeeds.
    await dataPath.raw`select 1`;
    return {
      pool,
      exports,
      deactivate: () => {
        active = false;
      },
    };
  } catch (error) {
    logger.error("Database setup failed: %O", error);
    active = false;
    await pool?.end().catch(() => undefined);
    throw new DatabasePluginError("SETUP_FAILED", "setup");
  }
}
