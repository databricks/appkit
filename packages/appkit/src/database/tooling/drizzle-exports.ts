import { getTableColumns, is, type Table } from "drizzle-orm";
import { PgEnumColumn } from "drizzle-orm/pg-core";

import type { Schema } from "../schema-builder";

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
