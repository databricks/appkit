/**
 * Databricks statement execution response interface
 * @property statement_id - the id of the statement
 * @property status - the status of the statement
 * @property manifest - the manifest of the statement
 * @property schema - the schema of the statement
 */
export interface DatabricksStatementExecutionResponse {
  statement_id: string;
  status: { state: string };
  manifest: {
    schema: {
      column_count: number;
      columns: {
        name: string;
        type_text: string;
        type_name: string;
        position: number;
        comment?: string;
      }[];
    };
  };
}

/**
 * Map of SQL types to their corresponding marker types
 * Used to convert SQL types to their corresponding marker types
 */
export const sqlTypeToMarker: Record<string, string> = {
  STRING: "SQLStringMarker",
  NUMERIC: "SQLNumberMarker",
  BOOLEAN: "SQLBooleanMarker",
  DATE: "SQLDateMarker",
  TIMESTAMP: "SQLTimestampMarker",
  BINARY: "SQLBinaryMarker",
};

/**
 * Map of SQL types to their corresponding helper function names
 * Used to generate JSDoc hints for parameters
 */
export const sqlTypeToHelper: Record<string, string> = {
  STRING: "sql.string()",
  NUMERIC: "sql.number()",
  BOOLEAN: "sql.boolean()",
  DATE: "sql.date()",
  TIMESTAMP: "sql.timestamp()",
  BINARY: "sql.binary()",
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
