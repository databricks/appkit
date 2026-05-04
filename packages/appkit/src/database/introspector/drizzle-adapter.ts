import { getTableConfig } from "drizzle-orm/pg-core";
import type { AppKitTable, Relation } from "../schema-builder/types";
import type { IntrospectedColumn } from "./types";

/** An adapted table. This is the shape of a table as it appears in the introspection result. */
interface AdaptedTable {
  /** The schema of the table. */
  schema: string;
  /** The columns of the table. */
  columns: IntrospectedColumn[];
}

/**
 * Adapts a Drizzle table to AppKit's introspection shape.
 *
 * This is the single boundary that reaches into Drizzle metadata. Everything
 * else consumes the AppKit-shaped output so Drizzle internals stay isolated in
 * this file.
 */
export function adaptDrizzleTable(table: AppKitTable): AdaptedTable {
  const config = getTableConfig(table.$drizzle as never) as DrizzleTableConfig;
  const relations = new Map(table.$relations.map((r) => [r.fromColumn, r]));
  const schema = config.schema ?? "public";

  return {
    schema,
    columns: config.columns.map((column) =>
      adaptColumn(column, table, relations.get(column.name), schema),
    ),
  };
}

/**
 * Adapts one Drizzle column, combining Drizzle's runtime metadata with AppKit's
 * column metadata for generated values and relation targets that AppKit tracks
 * more explicitly.
 */
function adaptColumn(
  column: DrizzleColumn,
  table: AppKitTable,
  relation: Relation | undefined,
  schema: string,
): IntrospectedColumn {
  const meta = table.$columns[column.name];
  const adapted: IntrospectedColumn = {
    name: column.name,
    pgType: drizzleTypeToPgType(column),
    nullable: !column.notNull,
    hasDefault: column.hasDefault,
  };

  if (column.default !== undefined)
    adapted.defaultExpression = String(column.default);
  if (column.primary) adapted.isPrimaryKey = true;
  if (
    meta?.serverGenerated ||
    (column.hasDefault && column.columnType === "PgSerial")
  ) {
    adapted.serverGenerated = true;
  }
  if (relation) {
    // FK targets live in the same logical schema as the source table.
    // `defineSchema({ schemaName })` is the single knob; we pass the
    // resolved name through so introspection diffs don't fight references
    // when the app uses `public` or a custom schema instead of `app`.
    adapted.references = {
      schema,
      table: relation.toTable,
      column: relation.toColumn,
    };
    if (relation.onDelete) adapted.references.onDelete = relation.onDelete;
    if (relation.onUpdate) adapted.references.onUpdate = relation.onUpdate;
  }

  return adapted;
}

/** Convert a Drizzle column type to a Postgres type. */
function drizzleTypeToPgType(column: DrizzleColumn): string {
  switch (column.columnType) {
    case "PgSerial":
    case "PgInteger":
      return "int4";
    case "PgBigInt":
    case "PgBigInt53":
      return "int8";
    case "PgText":
      return "text";
    case "PgVarchar":
      return "varchar";
    case "PgBoolean":
      return "bool";
    case "PgTimestamp":
      return column.withTimezone ? "timestamptz" : "timestamp";
    case "PgJsonb":
      return "jsonb";
    case "PgUuid":
      return "uuid";
    default:
      return column.dataType;
  }
}

/** A configuration for a Drizzle table. */
interface DrizzleTableConfig {
  schema?: string;
  columns: DrizzleColumn[];
}

/** A configuration for a Drizzle column. */
interface DrizzleColumn {
  name: string;
  columnType: string;
  dataType: string;
  notNull: boolean;
  hasDefault: boolean;
  default?: unknown;
  primary?: boolean;
  withTimezone?: boolean;
}
