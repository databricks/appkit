import type { TelemetryOptions } from "shared";

export interface AiSearchConnectorConfig {
  timeout?: number;
  telemetry?: TelemetryOptions;
}

export interface VsQueryParams {
  indexName: string;
  queryText?: string;
  queryVector?: number[];
  columns: string[];
  numResults: number;
  queryType: "ann" | "hybrid" | "full_text";
  filters?: Record<string, string | number | boolean | (string | number)[]>;
  reranker?: { columnsToRerank: string[] };
}

export interface VsNextPageParams {
  indexName: string;
  endpointName: string;
  pageToken: string;
}

/** Subset of the get-index response used for column auto-discovery. */
export interface VsIndexInfo {
  index_type?: "DELTA_SYNC" | "DIRECT_ACCESS";
  delta_sync_index_spec?: {
    source_table?: string;
    embedding_vector_columns?: Array<{ name: string }>;
  };
}

/** Subset of the Unity Catalog get-table response used for column discovery. */
export interface UcTableInfo {
  columns?: Array<{ name: string }>;
}

export interface VsRawResponse {
  manifest: {
    column_count: number;
    columns: Array<{ name: string; type?: string }>;
  };
  result: {
    row_count: number;
    data_array: unknown[][];
  };
  next_page_token?: string | null;
  debug_info?: {
    response_time?: number;
    ann_time?: number;
    embedding_gen_time?: number;
    latency_ms?: number;
    [key: string]: unknown;
  };
}
