/** Column metadata emitted into generated `database.columns.ts`. */
export interface ColumnInfo {
  name: string;
  /** Form-control bucket. `int*` → `number`, `timestamp*` → `date`. Add new pg types in `pgTypeToColumnInfoKind`. */
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
  /** Server-generated (serial/identity/default expr); hidden from create forms. */
  generated: boolean;
}

/** Single pg-type → bucket mapper used by database typegen. */
export function pgTypeToColumnInfoKind(pgType: string): ColumnInfo["type"] {
  switch (pgType) {
    case "int2":
    case "int4":
    case "numeric":
    case "float4":
    case "float8":
      return "number";
    case "int8":
      return "bigint";
    case "bool":
      return "boolean";
    case "json":
    case "jsonb":
      return "json";
    case "uuid":
      return "uuid";
    case "timestamp":
    case "timestamptz":
    case "date":
    case "time":
    case "timetz":
      return "date";
    case "text":
    case "varchar":
    case "char":
    case "bpchar":
      return "string";
    default:
      return "unknown";
  }
}
