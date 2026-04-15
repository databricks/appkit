import type { BasePluginConfig } from "shared";

export interface IVectorSearchConfig extends BasePluginConfig {
  timeout?: number;
  indexes: Record<string, IndexConfig>;
}

export interface IndexConfig {
  /** Three-level UC name: catalog.schema.index_name */
  indexName: string;
  /** Columns to return in results */
  columns: string[];
  /** Default search mode */
  queryType?: "ann" | "hybrid" | "full_text";
  /** Max results per query */
  numResults?: number;
  /** Enable built-in reranker. Pass true to rerank all non-id columns, or an object for fine control. */
  reranker?: boolean | RerankerConfig;
  /** Auth mode — "service-principal" uses the app's SP, "on-behalf-of-user" proxies the logged-in user's token */
  auth?: "service-principal" | "on-behalf-of-user";
  /** Enable cursor pagination */
  pagination?: boolean;
  /** VS endpoint name (required when pagination is true) */
  endpointName?: string;
  /**
   * For self-managed embedding indexes: converts query text to an embedding vector.
   * When provided, the plugin calls this function and sends query_vector to VS.
   * When omitted, query_text is sent and VS computes embeddings server-side (managed mode).
   */
  embeddingFn?: (text: string) => Promise<number[]>;
}

export interface RerankerConfig {
  columnsToRerank: string[];
}

export type SearchFilters = Record<
  string,
  string | number | boolean | (string | number)[]
>;

export interface SearchRequest {
  queryText?: string;
  queryVector?: number[];
  columns?: string[];
  numResults?: number;
  queryType?: "ann" | "hybrid" | "full_text";
  filters?: SearchFilters;
  reranker?: boolean;
}

export interface SearchResponse<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  results: SearchResult<T>[];
  totalCount: number;
  queryTimeMs: number;
  queryType: "ann" | "hybrid" | "full_text";
  nextPageToken: string | null;
}

export interface SearchResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  score: number;
  data: T;
}
