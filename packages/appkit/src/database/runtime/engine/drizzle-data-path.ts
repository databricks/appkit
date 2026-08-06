import { eq, isSQLWrapper, type SQL, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { createLogger } from "../../../logging/logger";
import {
  type DatabaseErrorCategory,
  DatabasePluginError,
  invalidDatabaseRequest,
} from "../../errors";
import type { AppKitTable, ColumnMeta, Schema } from "../../schema-builder";
import { buildEngineRelations } from "../../schema-builder/engine/relations";
import { columnValueSchema } from "../../schema-builder/validators";
import {
  andWhere,
  conflictTargetMeta,
  type DataPath,
  type IdValue,
  limitOrDefault,
  primaryKeyMeta,
  type Row,
  validateOffset,
  type WhereClause,
} from "../data-path";
import {
  columnOf,
  defaultColumns,
  selectToColumns,
  translateInclude,
  translateOrder,
  translateWhere,
} from "./translate";

const logger = createLogger("database");

/** Concrete Drizzle seam shared by the adapter and its focused tests. */
export type DrizzleDb = NodePgDatabase<Record<string, never>>;

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
    throw invalidDatabaseRequest(`Table "${table.$name}" is not registered`);
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
    throw invalidDatabaseRequest(`Table "${table.$name}" is not registered`);
  }
  return query;
}

function selectedColumns(
  table: AppKitTable,
  select?: readonly string[],
): Record<string, true> {
  return select === undefined
    ? defaultColumns(table)
    : selectToColumns(table, select);
}

/** Keep mutation identifiers schema-owned and every supplied value parameterized. */
function mutationValues(table: AppKitTable, values: Row): Row {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw invalidDatabaseRequest("Database mutation values must be an object");
  }
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(table.$columns, key)) {
      throw invalidDatabaseRequest(`Unknown column "${table.$name}.${key}"`);
    }
    if (isSQLWrapper(value)) {
      throw invalidDatabaseRequest(
        "Database mutation values cannot contain SQL",
      );
    }
  }
  return values;
}

// Drizzle wraps driver failures in DrizzleQueryError, so the SQLSTATE sits on a
// nested `cause` rather than the thrown error. Walk a bounded chain to find it.
const MAX_CAUSE_DEPTH = 5;

function sqlStateOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object") return undefined;
    try {
      const candidate = Reflect.get(current, "code");
      // SQLSTATE is always a five-character alphanumeric class code.
      if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) {
        return candidate;
      }
      current = Reflect.get(current, "cause");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Classify SQLSTATE without retaining the driver error or its properties. */
function classifyDriverError(error: unknown): DatabasePluginError {
  const code = sqlStateOf(error);
  const category: DatabaseErrorCategory =
    code === "42501"
      ? "FORBIDDEN"
      : code?.startsWith("23")
        ? "CONFLICT"
        : "INTERNAL";
  logger.error(
    "Database driver error classified as %s (SQLSTATE %s): %O",
    category,
    code ?? "unknown",
    error,
  );
  return new DatabasePluginError(category, "runtime");
}

async function runDatabaseOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DatabasePluginError) throw error;
    throw classifyDriverError(error);
  }
}

/** Resolve and validate the sole key once before a keyed operation executes. */
function validatedPrimaryKey(
  table: AppKitTable,
  id: unknown,
): { readonly meta: ColumnMeta; readonly value: IdValue } {
  const meta = primaryKeyMeta(table);
  const result = columnValueSchema(meta).safeParse(id);
  if (!result.success) {
    throw invalidDatabaseRequest(
      `Invalid primary-key value for "${table.$name}.${meta.columnName}"`,
    );
  }
  return { meta, value: result.data as IdValue };
}

// Enforce the single-row DataPath contract before results reach callers.
function expectExactlyOne(rows: Row[]): Row {
  if (rows.length !== 1) {
    throw new DatabasePluginError("INTERNAL", "runtime");
  }
  return rows[0];
}

function expectZeroOrOne(rows: Row[]): Row | null {
  if (rows.length > 1) {
    throw new DatabasePluginError("INTERNAL", "runtime");
  }
  return rows[0] ?? null;
}

/** Adapt a Drizzle database to AppKit's internal execution port. */
export function createDrizzleDataPath(db: DrizzleDb, schema: Schema): DataPath {
  const pgTable = (table: AppKitTable): PgTable => {
    assertRegisteredTable(schema, table);
    return table.$engine as unknown as PgTable;
  };
  const whereSql = (
    table: AppKitTable,
    where?: WhereClause,
  ): SQL | undefined =>
    where === undefined ? undefined : translateWhere(table, where);

  return {
    async select(table, spec) {
      return runDatabaseOperation(() =>
        relationalQueryBuilder(db, schema, table).findMany({
          where: whereSql(table, spec.where),
          orderBy:
            spec.order === undefined
              ? undefined
              : translateOrder(table, spec.order),
          columns: selectedColumns(table, spec.select),
          with:
            spec.include === undefined
              ? undefined
              : translateInclude(table, schema, spec.include),
          limit: limitOrDefault(spec.limit),
          offset:
            spec.offset === undefined ? undefined : validateOffset(spec.offset),
        }),
      );
    },

    async findOne(table, id, spec) {
      const { meta: primaryKey, value: validatedId } = validatedPrimaryKey(
        table,
        id,
      );
      const row = await runDatabaseOperation(() =>
        relationalQueryBuilder(db, schema, table).findFirst({
          where:
            spec?.where === undefined
              ? eq(columnOf(table, primaryKey.columnName), validatedId)
              : translateWhere(
                  table,
                  andWhere(
                    { [primaryKey.columnName]: { eq: validatedId } },
                    spec.where,
                  ),
                ),
          columns: selectedColumns(table, spec?.select),
          with:
            spec?.include === undefined
              ? undefined
              : translateInclude(table, schema, spec.include),
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
      const parameters = mutationValues(table, values);
      const rows = await runDatabaseOperation(() =>
        db.insert(engineTable).values(parameters).returning(),
      );
      return expectExactlyOne(rows as Row[]);
    },

    async update(table, id, values) {
      const engineTable = pgTable(table);
      const parameters = mutationValues(table, values);
      const { meta: primaryKey, value: validatedId } = validatedPrimaryKey(
        table,
        id,
      );
      const rows = await runDatabaseOperation(() =>
        db
          .update(engineTable)
          .set(parameters)
          .where(eq(columnOf(table, primaryKey.columnName), validatedId))
          .returning(),
      );
      return expectZeroOrOne(rows as Row[]);
    },

    async upsert(table, values, onConflict) {
      const engineTable = pgTable(table);
      const parameters = mutationValues(table, values);
      const target = conflictTargetMeta(table, onConflict);
      const rows = await runDatabaseOperation(() =>
        db
          .insert(engineTable)
          .values(parameters)
          .onConflictDoUpdate({
            target: columnOf(table, target.columnName),
            set: parameters,
          })
          .returning(),
      );
      return expectExactlyOne(rows as Row[]);
    },

    async delete(table, id) {
      const { meta: primaryKey, value: validatedId } = validatedPrimaryKey(
        table,
        id,
      );
      const rows = await runDatabaseOperation(() =>
        db
          .delete(pgTable(table))
          .where(eq(columnOf(table, primaryKey.columnName), validatedId))
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
        throw invalidDatabaseRequest(
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
          (error === callbackError ||
            callbackError instanceof DatabasePluginError)
        ) {
          throw callbackError;
        }
        if (error instanceof DatabasePluginError) throw error;
        throw classifyDriverError(error);
      }
    },
  };
}
