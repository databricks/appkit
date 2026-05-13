export interface SQLStringMarker {
  __sql_type: "STRING";
  value: string;
}

/**
 * SQL numeric parameter marker. The wire type controls how Databricks SQL
 * binds the value — notably, only integer types satisfy the `LIMIT` and
 * `OFFSET` clauses.
 *
 * - `BIGINT` / `INT` — integer columns, LIMIT/OFFSET, IDs
 * - `FLOAT` / `DOUBLE` — floating-point columns
 * - `NUMERIC` — fixed-point DECIMAL columns (preserves precision)
 *
 * Created by `sql.number()` (auto-inferred), or by typed variants
 * `sql.int()`, `sql.bigint()`, `sql.float()`, `sql.double()`, `sql.numeric()`.
 */
export interface SQLNumberMarker {
  __sql_type: "INT" | "BIGINT" | "FLOAT" | "DOUBLE" | "NUMERIC";
  value: string;
}

export interface SQLBooleanMarker {
  __sql_type: "BOOLEAN";
  value: string;
}

/**  SQL Binary marker is a STRING with hex encoding */
export interface SQLBinaryMarker {
  __sql_type: "STRING";
  value: string;
}

export interface SQLDateMarker {
  __sql_type: "DATE";
  value: string;
}

export interface SQLTimestampMarker {
  __sql_type: "TIMESTAMP";
  value: string;
}

/**
 * Object that identifies a typed SQL parameter.
 * Created using sql.date(), sql.string(), sql.number() (or the typed numeric
 * variants sql.int/bigint/float/double/numeric), sql.boolean(),
 * sql.timestamp(), or sql.binary().
 */
export type SQLTypeMarker =
  | SQLStringMarker
  | SQLNumberMarker
  | SQLBooleanMarker
  | SQLBinaryMarker
  | SQLDateMarker
  | SQLTimestampMarker;
