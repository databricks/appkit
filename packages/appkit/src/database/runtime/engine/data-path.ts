import { eq, type SQL, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import {
  type AppKitTable,
  buildEngineRelations,
  type Schema,
} from "@/database/schema-builder";
import {
  type DataPath,
  DataPathError,
  type IdValue,
  limitOrDefault,
  primaryKeyMeta,
  type QuerySpec,
  type Row,
  type WhereClause,
} from "../data-path";
import { defaultColumns } from "../projection";
import { colOf } from "./column";
import {
  selectToColumns,
  translateInclude,
  translateOrder,
  translateWhere,
} from "./translate";

export type AnyDb = NodePgDatabase<Record<string, never>>;

/** Create a Drizzle engine database from a pool and schema. */
export function createEngineDb(pool: Pool, schema: Schema): AnyDb {
  const relations = buildEngineRelations(schema.$tables);
  return drizzle(pool, {
    schema: { ...(schema.$engine as Record<string, unknown>), ...relations },
  }) as unknown as AnyDb;
}

/** The minimal relational-query-builder surface we use off `db.query`. */
interface RQB {
  findMany(config: Record<string, unknown>): Promise<Row[]>;
  findFirst(config: Record<string, unknown>): Promise<Row | undefined>;
}

function queryKeyOf(tables: Record<string, AppKitTable>, table: AppKitTable) {
  const exact = Object.entries(tables).find(
    ([, candidate]) => candidate === table,
  );
  if (exact) return exact[0];

  const byName = Object.entries(tables).find(
    ([, candidate]) => candidate.$name === table.$name,
  );
  return byName?.[0] ?? table.$name;
}

function rqb(
  db: AnyDb,
  tables: Record<string, AppKitTable>,
  table: AppKitTable,
): RQB {
  const queryKey = queryKeyOf(tables, table);
  const q = (db.query as unknown as Record<string, RQB>)[queryKey];
  if (!q)
    throw new DataPathError(
      `Table "${table.$name}" is not registered in the Drizzle schema`,
      500,
    );

  return q;
}

function columnsFor(
  table: AppKitTable,
  select?: string[],
): Record<string, true> {
  return select ? selectToColumns(table, select) : defaultColumns(table);
}

export function createEngineDataPath(db: AnyDb, schema: Schema): DataPath {
  const tables = schema.$tables;

  // the opaque engine handle back to a real PgTable
  const pgOf = (t: AppKitTable): PgTable => t.$engine as unknown as PgTable;

  const whereSql = (
    table: AppKitTable,
    where?: WhereClause,
  ): SQL | undefined =>
    where ? translateWhere(table, tables, where) : undefined;

  return {
    async select(table: AppKitTable, spec: QuerySpec) {
      return rqb(db, tables, table).findMany({
        where: whereSql(table, spec.where),
        orderBy: spec.order ? translateOrder(table, spec.order) : undefined,
        limit: limitOrDefault(spec.limit),
        offset: spec.offset,
        columns: columnsFor(table, spec.select),
        with: spec.include
          ? translateInclude(table, tables, spec.include)
          : undefined,
      });
    },
    async findOne(
      table: AppKitTable,
      id: IdValue,
      spec?: Pick<QuerySpec, "select" | "include">,
    ) {
      const pk = primaryKeyMeta(table);
      const row = await rqb(db, tables, table).findFirst({
        where: eq(colOf(table, pk.columnName), id),
        columns: columnsFor(table, spec?.select),
        with: spec?.include
          ? translateInclude(table, tables, spec.include)
          : undefined,
      });
      return row ?? null;
    },

    async count(table: AppKitTable, where?: WhereClause) {
      return db.$count(pgOf(table), whereSql(table, where));
    },

    async insert(table: AppKitTable, values: Row) {
      const [row] = await db.insert(pgOf(table)).values(values).returning();
      return row as Row;
    },

    async update(table: AppKitTable, id: IdValue, values: Row) {
      const pk = primaryKeyMeta(table);
      const [row] = await db
        .update(pgOf(table))
        .set(values)
        .where(eq(colOf(table, pk.columnName), id))
        .returning();
      return row ?? null;
    },

    async upsert(table: AppKitTable, values: Row, onConflict: string[]) {
      const target = onConflict.map((c) => colOf(table, c));
      const [row] = await db
        .insert(pgOf(table))
        .values(values)
        .onConflictDoUpdate({ target, set: values })
        .returning();
      return row as Row;
    },

    async delete(table: AppKitTable, id: IdValue) {
      const pk = primaryKeyMeta(table);
      const deleted = await db
        .delete(pgOf(table))
        .where(eq(colOf(table, pk.columnName), id))
        .returning({ id: colOf(table, pk.columnName) });
      return deleted.length > 0;
    },

    async getColumn(table: AppKitTable, id: IdValue, column: string) {
      const pk = primaryKeyMeta(table);
      const row = await rqb(db, tables, table).findFirst({
        where: eq(colOf(table, pk.columnName), id),
        columns: { [column]: true },
      });
      return row ? row[column] : null;
    },

    async raw<T = Row>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T[]> {
      const result = await db.execute(sql(strings, ...values));

      return ((result as { rows?: unknown }).rows ??
        (result as unknown)) as T[];
    },

    async transaction<T>(fn: (tx: DataPath) => Promise<T>) {
      return db.transaction(async (tx) => fn(createEngineDataPath(tx, schema)));
    },
  };
}
