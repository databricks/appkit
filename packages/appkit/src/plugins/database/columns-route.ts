import { type ColumnInfo, pgTypeToColumnInfoKind } from "shared";
import type { AppKitTable, Schema } from "@/database";
import { adaptDrizzleTable } from "@/database/introspector/drizzle-adapter";

/** Public column summary; `.private()` columns omitted. */
export function describeEntityColumns(table: AppKitTable): ColumnInfo[] {
  const adapted = adaptDrizzleTable(table);
  return adapted.columns
    .filter((col) => table.$columns[col.name]?.private !== true)
    .map((col) => ({
      name: col.name,
      type: pgTypeToColumnInfoKind(col.pgType),
      nullable: col.nullable,
      primaryKey: col.isPrimaryKey === true,
      hasDefault: col.hasDefault,
      generated: col.serverGenerated === true,
    }));
}

/** Resolve `entity` in `schema` and describe it, or `null` if not declared. */
export function describeEntityColumnsByName(
  schema: Schema,
  entity: string,
): ColumnInfo[] | null {
  const table = schema.$tables[entity];
  if (!table) return null;
  return describeEntityColumns(table);
}

/** Entry returned by `GET /api/database/_entities`. */
interface EntityInfo {
  name: string;
  primaryKey: string | null;
  /** Public columns (private ones filtered). */
  columns: ColumnInfo[];
}

/** Stable for the plugin's lifetime — compute once at boot. */
export function describeAllEntities(schema: Schema): EntityInfo[] {
  return Object.entries(schema.$tables).map(([name, table]) => ({
    name,
    primaryKey: pickPrimaryKey(table),
    columns: describeEntityColumns(table),
  }));
}

function pickPrimaryKey(table: AppKitTable): string | null {
  for (const [colName, meta] of Object.entries(table.$columns)) {
    if (meta.primaryKey) return colName;
  }
  return Object.keys(table.$columns).includes("id") ? "id" : null;
}
