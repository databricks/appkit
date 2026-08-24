import { eq, isSQLWrapper, type SQL, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import type { AppKitTable, Schema } from "../../schema-builder";
import { buildEngineRelations } from "../../schema-builder/engine/relations";
import {
  conflictTargetMeta,
  type DataPath,
  DataPathError,
  limitOrDefault,
  primaryKeyMeta,
  type Row,
  validateOffset,
  type WhereClause,
} from "../data-path";
import {
  columnOf,
  type ColumnAccess,
  defaultColumns,
  publicColumnNames,
  returningColumns,
  selectToColumns,
  translateInclude,
  translateOrder,
  translateWhere,
} from "./translate";

/** Concrete Drizzle seam shared by the adapter and its focused tests. */
export type DrizzleDb = NodePgDatabase<Record<string, never>>;

export interface DrizzleDataPathOptions {
  /** Explicit capability for trusted server code that must read private data. */
  readonly columnAccess?: ColumnAccess;
}

/** Bind finalized AppKit metadata to a relational Drizzle database. */
export function createDrizzleDb(pool: Pool, schema: Schema): DrizzleDb {
  const completeSchema: Record<string, unknown> = Object.assign(
    Object.create(null),
    schema.$engine,
    buildEngineRelations(schema.$tables),
  );
  return drizzle(pool, { schema: completeSchema }) as unknown as DrizzleDb;
}

interface RelationalQueryBuilder {
  findMany(config: Record<string, unknown>): Promise<Row[]>;
  findFirst(config: Record<string, unknown>): Promise<Row | undefined>;
}

/** Reject same-name or forged tables by requiring finalized object identity. */
function assertRegisteredTable(schema: Schema, table: AppKitTable): void {
  if (schema.$tables[table.$name] !== table) {
    throw new DataPathError(`Table "${table.$name}" is not registered`);
  }
}

function relationalQueryBuilder(
  db: DrizzleDb,
  schema: Schema,
  table: AppKitTable,
): RelationalQueryBuilder {
  assertRegisteredTable(schema, table);
  const query = (db.query as unknown as Record<string, RelationalQueryBuilder>)[
    table.$name
  ];
  if (!query) {
    throw new DataPathError(`Table "${table.$name}" is not registered`);
  }
  return query;
}

function selectedColumns(
  table: AppKitTable,
  select?: readonly string[],
  access: ColumnAccess = "public",
): Record<string, true> {
  return select === undefined
    ? defaultColumns(table)
    : selectToColumns(table, select, access);
}

type MutationKind = "insert" | "update";

interface MutationSchema {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false };
}

/** Apply the finalized write schema again at the persistence boundary. */
function mutationValues(
  table: AppKitTable,
  values: Row,
  kind: MutationKind,
): Row {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new DataPathError("Database mutation values must be an object");
  }
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(table.$columns, key)) {
      throw new DataPathError(`Unknown column "${table.$name}.${key}"`);
    }
    if (isSQLWrapper(value)) {
      throw new DataPathError("Database mutation values cannot contain SQL");
    }
  }
  const schema = (
    kind === "insert" ? table.$insertSchema : table.$updateSchema
  ) as MutationSchema;
  const result = schema.safeParse(values);
  if (!result.success) {
    throw new DataPathError(`Invalid database ${kind} values`);
  }
  return result.data as Row;
}

/** Never change row identity or the conflict key during the update half. */
function upsertUpdateValues(
  table: AppKitTable,
  parameters: Row,
  conflictTarget: string,
): Row {
  const updates: Row = {};
  for (const [key, value] of Object.entries(parameters)) {
    const column = table.$columns[key];
    if (
      column.primaryKey ||
      column.serverGenerated ||
      column.columnName === conflictTarget
    ) {
      continue;
    }
    updates[key] = value;
  }
  if (Object.keys(updates).length > 0) return updates;

  // A safe self-assignment preserves the exactly-one-row upsert contract.
  return { [conflictTarget]: columnOf(table, conflictTarget) };
}

async function runDatabaseOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DataPathError) throw error;
    // Raw driver details stop at the adapter boundary.
    throw new DataPathError("Database operation failed");
  }
}

/** Drop private columns before cardinality checks so expect* never sees them. */
function publicMutationRows(table: AppKitTable, rows: Row[]): Row[] {
  const names = publicColumnNames(table);
  return rows.map((row) => {
    const projected: Row = {};
    for (const name of names) {
      if (Object.hasOwn(row, name)) projected[name] = row[name];
    }
    return projected;
  });
}

// Enforce the single-row DataPath contract before results reach callers.
function expectExactlyOne(rows: Row[]): Row {
  if (rows.length !== 1) {
    throw new DataPathError("Database mutation did not return exactly one row");
  }
  return rows[0];
}

function expectZeroOrOne(rows: Row[]): Row | null {
  if (rows.length > 1) {
    throw new DataPathError("Database mutation returned more than one row");
  }
  return rows[0] ?? null;
}

/** Adapt a Drizzle database to the backend-neutral DataPath contract. */
export function createDrizzleDataPath(
  db: DrizzleDb,
  schema: Schema,
  options: DrizzleDataPathOptions = {},
): DataPath {
  const columnAccess = options.columnAccess ?? "public";
  const pgTable = (table: AppKitTable): PgTable => {
    assertRegisteredTable(schema, table);
    return table.$engine as unknown as PgTable;
  };
  const whereSql = (
    table: AppKitTable,
    where?: WhereClause,
  ): SQL | undefined =>
    where === undefined
      ? undefined
      : translateWhere(table, where, columnAccess);

  return {
    async select(table, spec) {
      return runDatabaseOperation(() =>
        relationalQueryBuilder(db, schema, table).findMany({
          where: whereSql(table, spec.where),
          orderBy:
            spec.order === undefined
              ? undefined
              : translateOrder(table, spec.order, columnAccess),
          columns: selectedColumns(table, spec.select, columnAccess),
          with:
            spec.include === undefined
              ? undefined
              : translateInclude(table, schema, spec.include, columnAccess),
          limit: limitOrDefault(spec.limit),
          offset:
            spec.offset === undefined ? undefined : validateOffset(spec.offset),
        }),
      );
    },

    async findOne(table, id, spec) {
      const primaryKey = primaryKeyMeta(table);
      const row = await runDatabaseOperation(() =>
        relationalQueryBuilder(db, schema, table).findFirst({
          where: eq(columnOf(table, primaryKey.columnName), id),
          columns: selectedColumns(table, spec?.select, columnAccess),
          with:
            spec?.include === undefined
              ? undefined
              : translateInclude(table, schema, spec.include, columnAccess),
        }),
      );
      return row ?? null;
    },

    async count(table, where) {
      return runDatabaseOperation(() =>
        db.$count(pgTable(table), whereSql(table, where)),
      );
    },

    async insert(table, values) {
      const engineTable = pgTable(table);
      const parameters = mutationValues(table, values, "insert");
      const rows = await runDatabaseOperation(() =>
        db
          .insert(engineTable)
          .values(parameters)
          .returning(returningColumns(table)),
      );
      return expectExactlyOne(publicMutationRows(table, rows as Row[]));
    },

    async update(table, id, values) {
      const engineTable = pgTable(table);
      const parameters = mutationValues(table, values, "update");
      const primaryKey = primaryKeyMeta(table);
      const rows = await runDatabaseOperation(() =>
        db
          .update(engineTable)
          .set(parameters)
          .where(eq(columnOf(table, primaryKey.columnName), id))
          .returning(returningColumns(table)),
      );
      return expectZeroOrOne(publicMutationRows(table, rows as Row[]));
    },

    async upsert(table, values, onConflict) {
      const engineTable = pgTable(table);
      const parameters = mutationValues(table, values, "insert");
      const target = conflictTargetMeta(table, onConflict);
      const updates = upsertUpdateValues(table, parameters, target.columnName);
      const rows = await runDatabaseOperation(() =>
        db
          .insert(engineTable)
          .values(parameters)
          .onConflictDoUpdate({
            target: columnOf(table, target.columnName),
            set: updates,
          })
          .returning(returningColumns(table)),
      );
      return expectExactlyOne(publicMutationRows(table, rows as Row[]));
    },

    async delete(table, id) {
      const primaryKey = primaryKeyMeta(table);
      const rows = await runDatabaseOperation(() =>
        db
          .delete(pgTable(table))
          .where(eq(columnOf(table, primaryKey.columnName), id))
          .returning({ id: columnOf(table, primaryKey.columnName) }),
      );
      return expectZeroOrOne(rows as Row[]) !== null;
    },

    async raw<T = Row>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T[]> {
      // SQL wrappers carry structure; tagged interpolations may carry values only.
      if (values.some((value) => isSQLWrapper(value))) {
        throw new DataPathError(
          "Tagged SQL interpolations must be parameter values",
        );
      }
      const result = await runDatabaseOperation(() =>
        db.execute(sql(strings, ...values.map((value) => sql.param(value)))),
      );
      return ((result as { rows?: unknown }).rows ?? result) as T[];
    },

    async transaction<T>(callback: (tx: DataPath) => Promise<T>): Promise<T> {
      let callbackFailed = false;
      let callbackError: unknown;
      try {
        return await db.transaction(async (transaction) => {
          try {
            return await callback(
              createDrizzleDataPath(
                transaction as unknown as DrizzleDb,
                schema,
                { columnAccess },
              ),
            );
          } catch (error) {
            callbackFailed = true;
            callbackError = error;
            throw error;
          }
        });
      } catch (error) {
        // Callback errors are application-owned; sanitize only tx lifecycle errors.
        if (
          callbackFailed &&
          (error === callbackError || callbackError instanceof DataPathError)
        ) {
          throw callbackError;
        }
        if (error instanceof DataPathError) throw error;
        throw new DataPathError("Database operation failed");
      }
    },
  };
}
