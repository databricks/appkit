/**
 * Databricks statement execution response interface for DESCRIBE QUERY
 * @property statement_id - the id of the statement
 * @property status - the status of the statement
 * @property result - the result containing column schema as rows [col_name, data_type, comment]
 */
export interface DatabricksStatementExecutionResponse {
  statement_id: string;
  status: {
    state: string;
    error?: { error_code?: string; message?: string };
  };
  result?: {
    data_array?: (string | null)[][];
  };
}

/**
 * Map of SQL types to their corresponding marker types
 * Used to convert SQL types to their corresponding marker types
 */
export const sqlTypeToMarker: Record<string, string> = {
  // string
  STRING: "SQLStringMarker",
  BINARY: "SQLBinaryMarker",
  // boolean
  BOOLEAN: "SQLBooleanMarker",
  // numeric
  NUMERIC: "SQLNumberMarker",
  INT: "SQLNumberMarker",
  BIGINT: "SQLNumberMarker",
  TINYINT: "SQLNumberMarker",
  SMALLINT: "SQLNumberMarker",
  FLOAT: "SQLNumberMarker",
  DOUBLE: "SQLNumberMarker",
  DECIMAL: "SQLNumberMarker",
  // date/time
  DATE: "SQLDateMarker",
  TIMESTAMP: "SQLTimestampMarker",
  TIMESTAMP_NTZ: "SQLTimestampMarker",
};

/**
 * Map of SQL types to their corresponding helper function names
 * Used to generate JSDoc hints for parameters
 */
export const sqlTypeToHelper: Record<string, string> = {
  // string
  STRING: "sql.string()",
  BINARY: "sql.binary()",
  // boolean
  BOOLEAN: "sql.boolean()",
  // numeric — route each SQL type to its closest typed helper. INT/BIGINT
  // are critical for LIMIT/OFFSET; FLOAT/DOUBLE preserve precision intent;
  // NUMERIC/DECIMAL route to sql.numeric() for exact-decimal columns.
  NUMERIC: "sql.numeric()",
  DECIMAL: "sql.numeric()",
  BIGINT: "sql.bigint()",
  INT: "sql.int()",
  TINYINT: "sql.int()",
  SMALLINT: "sql.int()",
  FLOAT: "sql.float()",
  DOUBLE: "sql.double()",
  // date/time
  DATE: "sql.date()",
  TIMESTAMP: "sql.timestamp()",
  TIMESTAMP_NTZ: "sql.timestamp()",
};

/**
 * Query schema interface
 * @property name - the name of the query
 * @property type - the type of the query (string, number, boolean, object, array, etc.)
 */
export interface QuerySchema {
  name: string;
  type: string;
}

/**
 * A genuine SQL error: `DESCRIBE QUERY` ran against a *reachable* warehouse and
 * the warehouse reported the statement as FAILED (bad table, syntax error,
 * incompatible type, …). Distinct from a connectivity failure (warehouse
 * unreachable), which is non-fatal and never recorded here.
 * @property name - the query name
 * @property message - the SQL error message reported by the warehouse
 */
export interface QuerySyntaxError {
  name: string;
  message: string;
}

/**
 * A non-SQL fatal error while attempting to describe a query: authentication,
 * authorization, invalid warehouse/configuration, malformed SDK request, or
 * any other setup problem that should not be treated as an offline warehouse.
 * @property name - the query name
 * @property message - the fatal error message
 */
export interface QueryFatalError {
  name: string;
  message: string;
}

/**
 * Result of describing a folder of queries.
 * @property schemas - one schema per query, in original file order. Queries that
 *   could not be described carry `result: unknown` so output stays valid.
 * @property syntaxErrors - queries whose DESCRIBE failed against a reachable
 *   warehouse (genuine SQL errors). Connectivity failures are deliberately NOT
 *   included: they degrade silently (reuse last-known-good type or emit
 *   `unknown`) so a transient outage never fails a build.
 * @property fatalErrors - non-SQL fatal describe request failures. These still
 *   produce `result: unknown` schemas so callers can write declarations before
 *   surfacing the error.
 */
export interface QueryGenerationResult {
  schemas: QuerySchema[];
  syntaxErrors: QuerySyntaxError[];
  fatalErrors: QueryFatalError[];
}
