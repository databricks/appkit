/** Coarse classification of a Postgres column. */
export type ColumnInfoKind =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "date"
  | "json"
  | "uuid"
  | "enum"
  | "unknown";

export interface ColumnInfo {
  /** Column name as stored in Postgres */
  name: string;
  /**  Canonical postgres data type */
  pgType: string;
  /** Coarse classifier derived from {@link pgTypeToColumnInfoKind}. */
  kind: ColumnInfoKind;
  /** Whether the column accepts NULL. */
  nullable: boolean;
  /** Part of the primary key. */
  isPrimaryKey: boolean;
  /** Value is produced by the database (serial / default), so it is omitted from inserts. */
  isServerGenerated: boolean;
  /** Hidden from HTTP responses (`.private()`); reachable only by trusted server code. */
  isPrivate: boolean;
  /** Enum members when {@link kind} is `"enum"`. */
  enumValues?: readonly string[];
}

const STRING_TYPES = new Set([
  "text",
  "varchar",
  "character varying",
  "char",
  "character",
  "bpchar",
  "name",
  "citext",
]);

const NUMBER_TYPES = new Set([
  "int2",
  "smallint",
  "int4",
  "int",
  "integer",
  "serial",
  "serial4",
  "smallserial",
  "real",
  "float4",
  "float8",
  "double precision",
  "numeric",
  "decimal",
  "money",
]);

const BIGINT_TYPES = new Set(["int8", "bigint", "bigserial", "serial8"]);

const BOOLEAN_TYPES = new Set(["bool", "boolean"]);

const DATE_TYPES = new Set([
  "timestamp",
  "timestamptz",
  "timestamp with time zone",
  "timestamp without time zone",
  "date",
  "time",
  "timetz",
  "time with time zone",
  "time without time zone",
]);

const JSON_TYPES = new Set(["json", "jsonb"]);

/**
 * Normalize a raw Postgres type token: lower-case, strip a length/precision
 * specifier (`varchar(255)` → `varchar`) and a trailing array marker (`text[]`).
 */
export function normalizePgType(pgType: string): string {
  return pgType
    .trim()
    .toLowerCase()
    .replace(/\[\]$/, "")
    .replace(/\(.*\)$/, "")
    .trim();
}

/**
 * Map a Postgres type to a coarse {@link ColumnInfoKind}. Enum columns are user
 * (custom) types and are classified by the schema-builder/introspector directly,
 * so an unrecognized type falls back to `"unknown"` here.
 */
export function pgTypeToColumnInfoKind(pgType: string): ColumnInfoKind {
  const t = normalizePgType(pgType);
  if (STRING_TYPES.has(t)) return "string";
  if (NUMBER_TYPES.has(t)) return "number";
  if (BIGINT_TYPES.has(t)) return "bigint";
  if (BOOLEAN_TYPES.has(t)) return "boolean";
  if (DATE_TYPES.has(t)) return "date";
  if (JSON_TYPES.has(t)) return "json";
  if (t === "uuid") return "uuid";
  return "unknown";
}
