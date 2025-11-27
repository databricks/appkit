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

/**
 * Query Registry for type-safe analytics queries.
 * Extend this interface via module augmentation to get full type inference:
 *
 * @example
 * ```typescript
 * // config/appKitTypes.d.ts
 * declare module "@databricks/app-kit-ui/react" {
 *   interface QueryRegistry {
 *     apps_list: AppListItem[];
 *     spend_summary: SpendSummary[];
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: Required for module augmentation
export interface QueryRegistry {}

/** Resolves to registry keys if defined, otherwise string */
export type QueryKey = keyof QueryRegistry extends never
  ? string
  : keyof QueryRegistry;

// biome-ignore lint/suspicious/noEmptyInterface: Required for module augmentation
export interface PluginRegistry {}

export type PluginName = keyof PluginRegistry extends never
  ? string
  : keyof PluginRegistry;

export type PluginRoutes<P extends PluginName> = P extends keyof PluginRegistry
  ? keyof PluginRegistry[P]
  : string;

export type RouteResponse<
  P extends PluginName,
  R extends PluginRoutes<P>,
> = P extends keyof PluginRegistry
  ? R extends keyof PluginRegistry[P]
    ? PluginRegistry[P][R]
    : unknown
  : unknown;
