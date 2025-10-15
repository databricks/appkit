/* strict aligned with execute statement API documentation */

/* Request Types */
export interface ParameterInput {
  name: string;
  value?: string | null;
  type?: "NUMERIC" | "STRING" | "BOOLEAN" | "DATE" | "TIMESTAMP";
}

export type Disposition = "INLINE" | "EXTERNAL_LINKS";
export type Format = "JSON_ARRAY" | "ARROW_STREAM" | "CSV";
export type OnWaitTimeout = "CONTINUE" | "CANCEL";

export interface ExecuteStatementRequest {
  /** The SQL statement to execute. The maximum query text size is 16 MiB. */
  statement: string;
  /** Warehouse upon which to execute a statement */
  warehouse_id: string;
  /** A list of parameters to pass into a SQL statement containing parameter markers */
  parameters?: ParameterInput[];
  /** Sets default catalog for statement execution, similar to USE CATALOG in SQL */
  catalog?: string;
  /** Sets default schema for statement execution, similar to USE SCHEMA in SQL */
  schema?: string;
  /** The fetch disposition: INLINE or EXTERNAL_LINKS (default: INLINE) */
  disposition?: Disposition;
  /** Result format: JSON_ARRAY, ARROW_STREAM, or CSV (default: JSON_ARRAY) */
  format?: Format;
  /** Applies the given byte limit to the statement's result size */
  byte_limit?: number;
  /** Applies the given row limit to the statement's result set */
  row_limit?: number;
  /** The time in seconds the call will wait for the statement's result set (default: 10s) */
  wait_timeout?: string;
  /** Behavior when wait_timeout is exceeded: CONTINUE or CANCEL (default: CONTINUE) */
  on_wait_timeout?: OnWaitTimeout;
}

/* Response Types */
export type StatementState =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "CLOSED";

export type ErrorCode =
  | "UNKNOWN"
  | "INTERNAL_ERROR"
  | "TEMPORARILY_UNAVAILABLE"
  | "IO_ERROR"
  | "BAD_REQUEST"
  | "SERVICE_UNDER_MAINTENANCE"
  | "WORKSPACE_TEMPORARILY_UNAVAILABLE"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "RESOURCE_EXHAUSTED"
  | "ABORTED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "UNAUTHENTICATED";

export interface StatementError {
  error_code: ErrorCode;
  message: string;
}

export interface StatementStatus {
  state: StatementState;
  error?: StatementError;
}

export interface ResultChunkMetadata {
  /** The position within the sequence of result set chunks */
  chunk_index: number;
  /** The starting row offset within the result set */
  row_offset: number;
  /** The number of rows within the result chunk */
  row_count: number;
  /** The number of bytes in the result chunk (not available with INLINE disposition) */
  byte_count?: number;
}

export interface ColumnDescription {
  name: string;
  type_text: string;
  type_name: string;
  position: number;
  type_precision?: number;
  type_scale?: number;
  type_interval_type?: string;
  nullable?: boolean;
}

export interface ResultManifest {
  /** The schema is an ordered list of column descriptions */
  schema: {
    columns: ColumnDescription[];
  };
  /** Array of result set chunk metadata */
  chunks: ResultChunkMetadata[];
  /** Result format */
  format: Format;
  /** The total number of rows in the result set */
  total_row_count: number;
  /** The total number of chunks that the result set has been divided into */
  total_chunk_count: number;
  /** The total number of bytes in the result set (not available with INLINE disposition) */
  total_byte_count?: number;
  /** Indicates whether the result is truncated due to row_limit or byte_limit */
  truncated?: boolean;
}

export interface ExternalLink {
  /** A presigned URL pointing to a chunk of result data */
  external_link: string;
  /** Indicates when the external link will expire */
  expiration: string;
  /** The position within the sequence of result set chunks */
  chunk_index: number;
  /** The starting row offset within the result set */
  row_offset: number;
  /** The number of rows within the result chunk */
  row_count: number;
  /** The number of bytes in the result chunk */
  byte_count?: number;
  /** The chunk_index for the next chunk. If absent, indicates there are no more chunks */
  next_chunk_index?: number;
  /** A link to fetch the next chunk. If absent, indicates there are no more chunks */
  next_chunk_internal_link?: string;
}

export interface ResultData {
  /** The position within the sequence of result set chunks */
  chunk_index: number;
  /** The starting row offset within the result set */
  row_offset: number;
  /** The number of rows within the result chunk */
  row_count: number;
  /** The number of bytes in the result chunk */
  byte_count?: number;
  /** The chunk_index for the next chunk. If absent, indicates there are no more chunks */
  next_chunk_index?: number;
  /** A link to fetch the next chunk. If absent, indicates there are no more chunks */
  next_chunk_internal_link?: string;
  /** Result data as an array of arrays (only for INLINE disposition with JSON_ARRAY format) */
  data_array?: Array<Array<string | null>>;
  /** Presigned URLs to result data (only for EXTERNAL_LINKS disposition) */
  external_links?: ExternalLink[];
}

export interface ExecuteStatementResponse {
  /** The statement ID is returned upon successfully submitting a SQL statement */
  statement_id: string;
  /** The status includes execution state and if relevant, error information */
  status: StatementStatus;
  /** The result manifest provides schema and metadata for the result set */
  manifest?: ResultManifest;
  /** Contains the result data of a single chunk (when available) */
  result?: ResultData;
}
