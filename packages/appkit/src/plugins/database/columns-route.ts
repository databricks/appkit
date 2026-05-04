import type { AppKitTable, Schema } from "@/database";
import { adaptDrizzleTable } from "@/database/introspector/drizzle-adapter";

/**
 * Runtime column metadata exposed by `GET /api/database/<entity>/_columns`.
 *
 * The browser uses this to auto-render edit/create forms without needing
 * to know the schema at build time. It intentionally mirrors a conservative
 * subset of `IntrospectedColumn` — enough to pick a form control, not enough
 * to reconstruct SQL. Anything richer should go through the live-introspect
 * path, not the per-entity HTTP surface.
 */
export interface ColumnInfo {
  name: string;
  /**
   * Form-control bucket derived from Postgres `udt_name`. Not a full SQL
   * type; we group `int4`/`int8`/`float4` as `"number"` and both
   * `timestamp` and `timestamptz` as `"date"` because the UI doesn't care
   * about the wire distinction.
   */
  type:
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "json"
    | "uuid"
    | "bigint"
    | "unknown";
  nullable: boolean;
  primaryKey: boolean;
  hasDefault: boolean;
  /**
   * True when Postgres generates the value (serial, identity, server-side
   * default expression marked `serverGenerated`). Form renderers hide these
   * from create flows by default.
   */
  generated: boolean;
}

/**
 * Extract a stable, JSON-serialisable column summary for one entity.
 *
 * Uses the same `adaptDrizzleTable` boundary as drift detection so the
 * browser sees exactly what the server considers the declared schema —
 * no separate "form schema" source of truth. Columns marked `.private()`
 * are omitted so secrets like password hashes never appear in the form
 * builder, the autocomplete surface, or anywhere a curious client looks.
 */
export function describeEntityColumns(table: AppKitTable): ColumnInfo[] {
  const adapted = adaptDrizzleTable(table);
  return adapted.columns
    .filter((col) => table.$columns[col.name]?.private !== true)
    .map((col) => ({
      name: col.name,
      type: pgTypeToFormType(col.pgType),
      nullable: col.nullable,
      primaryKey: col.isPrimaryKey === true,
      hasDefault: col.hasDefault,
      generated: col.serverGenerated === true,
    }));
}

/**
 * Convenience for route handlers: resolve an entity name against the plugin's
 * declared schema and return its column metadata, or `null` when the entity
 * does not exist in the schema.
 */
export function describeEntityColumnsByName(
  schema: Schema,
  entity: string,
): ColumnInfo[] | null {
  const table = schema.$tables[entity];
  if (!table) return null;
  return describeEntityColumns(table);
}

/**
 * Map a Postgres catalog type to a form-control bucket. Keep the buckets
 * narrow: the browser renders a single control per bucket today, so we only
 * need to distinguish things that need different inputs (text vs number vs
 * toggle vs date picker vs textarea).
 */
function pgTypeToFormType(pgType: string): ColumnInfo["type"] {
  switch (pgType) {
    case "text":
    case "varchar":
    case "bpchar":
    case "char":
      return "string";
    case "int2":
    case "int4":
    case "float4":
    case "float8":
    case "numeric":
      return "number";
    case "int8":
      return "bigint";
    case "bool":
      return "boolean";
    case "timestamp":
    case "timestamptz":
    case "date":
    case "time":
    case "timetz":
      return "date";
    case "jsonb":
    case "json":
      return "json";
    case "uuid":
      return "uuid";
    default:
      return "unknown";
  }
}
