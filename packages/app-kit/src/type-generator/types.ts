/**
 * Databricks statement execution response interface for DESCRIBE QUERY
 * @property statement_id - the id of the statement
 * @property status - the status of the statement
 * @property result - the result containing column schema as rows [col_name, data_type, comment]
 */
export interface DatabricksStatementExecutionResponse {
  statement_id: string;
  status: { state: string };
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
  // numeric
  NUMERIC: "sql.number()",
  INT: "sql.number()",
  BIGINT: "sql.number()",
  TINYINT: "sql.number()",
  SMALLINT: "sql.number()",
  FLOAT: "sql.number()",
  DOUBLE: "sql.number()",
  DECIMAL: "sql.number()",
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
