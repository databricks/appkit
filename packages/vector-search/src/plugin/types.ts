// ============================================
// Plugin Configuration Types
// ============================================

export interface VectorSearchPluginConfig {
  indexes: Record<string, IndexConfig>;
}

export interface IndexConfig {
  /** Three-level UC name: catalog.schema.index_name */
  indexName: string;
  /** Columns to return in results */
  columns: string[];
  /** Default search mode */
  queryType?: 'ann' | 'hybrid' | 'full_text';  // default: 'hybrid'
  /** Max results per query */
  numResults?: number;  // default: 20
  /** Enable built-in reranker */
  reranker?: boolean | RerankerConfig;  // default: false
  /** Auth mode */
  auth?: 'service-principal' | 'on-behalf-of-user';  // default: 'service-principal'
  /** Result caching */
  cache?: CacheConfig;
  /** Enable cursor pagination */
  pagination?: boolean;  // default: false
  /** VS endpoint name (required if pagination: true) */
  endpointName?: string;
  /**
   * For self-managed embedding indexes: converts query text to embedding vector.
   * If provided, the plugin calls this function and sends query_vector to VS.
   * If omitted, the plugin sends query_text and VS computes embeddings (managed mode).
   */
  embeddingFn?: (text: string) => Promise<number[]>;
}

export interface RerankerConfig {
  columnsToRerank: string[];
}

export interface CacheConfig {
  enabled: boolean;
  ttlSeconds?: number;  // default: 60
  maxEntries?: number;  // default: 1000
}

// ============================================
// Query Types (frontend → backend)
// ============================================

export interface SearchRequest {
  /** Text query. Required for managed embedding indexes. */
  queryText?: string;
  /** Pre-computed embedding vector. Required for self-managed indexes without embeddingFn. */
  queryVector?: number[];
  /** Override default columns for this query */
  columns?: string[];
  /** Override default numResults for this query */
  numResults?: number;
  /** Override default queryType for this query */
  queryType?: 'ann' | 'hybrid' | 'full_text';
  /** Metadata filters */
  filters?: SearchFilters;
  /** Override reranker for this query */
  reranker?: boolean;
}

/**
 * Filters use the VS REST API filter format.
 * Keys are column names with optional operators.
 *
 * Examples:
 *   { category: ['electronics', 'books'] }          // IN list
 *   { 'price >=': 10 }                               // comparison
 *   { 'title NOT': 'test' }                           // NOT
 *   { 'name LIKE': 'data%' }                          // LIKE
 *   { 'color1 OR color2': ['red', 'blue'] }           // OR across columns
 */
export type SearchFilters = Record<string, string | number | boolean | (string | number)[]>;

// ============================================
// Result Types (backend → frontend)
// ============================================

export interface SearchResponse<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Search results */
  results: SearchResult<T>[];
  /** Total number of results */
  totalCount: number;
  /** Query execution time in ms (from VS debug info) */
  queryTimeMs: number;
  /** The query type that was actually used */
  queryType: 'ann' | 'hybrid' | 'full_text';
  /** Whether results were served from cache */
  fromCache: boolean;
  /** Token for fetching next page. Null if no more results. */
  nextPageToken: string | null;
}

export interface SearchResult<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Similarity score (0-1, higher = more similar) */
  score: number;
  /** The result data — keys match the columns requested */
  data: T;
}

// ============================================
// Error Types
// ============================================

export interface SearchError {
  code: 'UNAUTHORIZED' | 'INDEX_NOT_FOUND' | 'INVALID_QUERY' | 'RATE_LIMITED' | 'INTERNAL';
  message: string;
  /** HTTP status from VS API */
  statusCode: number;
}

// ============================================
// Hook Types
// ============================================

export interface UseVectorSearchOptions {
  /** Debounce delay in ms. Default: 300 */
  debounceMs?: number;
  /** Override default numResults from server config */
  numResults?: number;
  /** Override default queryType from server config */
  queryType?: 'ann' | 'hybrid' | 'full_text';
  /** Override reranker from server config */
  reranker?: boolean;
  /** Initial filters */
  initialFilters?: SearchFilters;
  /** Callback when search completes */
  onResults?: (response: SearchResponse) => void;
  /** Callback on error */
  onError?: (error: SearchError) => void;
  /** Minimum query length before searching. Default: 1 */
  minQueryLength?: number;
}

export interface UseVectorSearchReturn<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Execute a search */
  search: (query: string) => void;
  /** Current results */
  results: SearchResult<T>[];
  /** Whether a search is in flight */
  isLoading: boolean;
  /** Error from the last search, if any */
  error: SearchError | null;
  /** Total result count */
  totalCount: number;
  /** Query time in ms */
  queryTimeMs: number;
  /** Whether results came from cache */
  fromCache: boolean;
  /** Current query text */
  query: string;
  /** Set filters programmatically */
  setFilters: (filters: SearchFilters) => void;
  /** Current active filters */
  activeFilters: SearchFilters;
  /** Clear all filters and results */
  clear: () => void;
  /** Whether more results are available (pagination) */
  hasMore?: boolean;
  /** Fetch next page and append to results (pagination) */
  loadMore?: () => void;
  /** Whether a loadMore is in flight (pagination) */
  isLoadingMore?: boolean;
}

// ============================================
// Internal Types (not exported from package)
// ============================================

/** Raw response from VS REST API */
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

/** Token provider interface for auth */
export interface TokenProvider {
  getToken(): Promise<string>;
}
