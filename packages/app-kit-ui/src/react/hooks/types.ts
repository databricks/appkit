/** Options for configuring an analytics SSE query */
export interface UseAnalyticsQueryOptions {
  /** Response format  */
  format?: "JSON"; // later support for ARROW

  /** Maximum size of serialized parameters in bytes */
  maxParametersSize?: number;

  /** Whether to automatically start the query when the hook is mounted. Default is true. */
  autoStart?: boolean;
}

/** Result state returned by useAnalyticsQuery */
export interface UseAnalyticsQueryResult<T> {
  /** Latest query result data */
  data: T | null;
  /** Loading state of the query */
  loading: boolean;
  /** Error state of the query */
  error: string | null;
}
