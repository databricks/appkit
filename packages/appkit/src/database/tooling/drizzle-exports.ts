import { getTableColumns, is, type Table } from "drizzle-orm";
import { PgEnumColumn } from "drizzle-orm/pg-core";

import type { Schema } from "../schema-builder";

/**
 * The "module exports" drizzle-kit snapshots: every engine table plus every
 * enum a column references. The pgSchema object is never included, so
 * generated SQL contains no CREATE SCHEMA; the migrator creates the schema as
 * the identity that applies the migrations, which then owns it.
 */
export function drizzleKitImports(schema: Schema): Record<string, unknown> {
  const imports: Record<string, unknown> = Object.create(null);
  for (const [name, table] of Object.entries(schema.$engine)) {
    imports[`table:${name}`] = table;
    const columns = getTableColumns(table as unknown as Table);
    for (const column of Object.values(columns)) {
      if (is(column, PgEnumColumn)) {
        imports[`enum:${column.enum.enumName}`] = column.enum;
      }
    }
  }
  return imports;
}
