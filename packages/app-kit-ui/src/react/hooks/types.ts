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
export interface QueryRegistry {
  [key: string]: any[];
}

/** Gets only literal keys from a registry (excludes index signature) */
export type AugmentedRegistry<T> = keyof {
  [K in keyof T as string extends K ? never : K]: T[K];
};

/** Resolves to registry keys if defined, otherwise string */
export type QueryKey = AugmentedRegistry<QueryRegistry> extends never
  ? string
  : AugmentedRegistry<QueryRegistry>;

/**
 * Infers result type: uses QueryRegistry if key exists, otherwise falls back to explicit type T
 */
export type InferResult<T, K> = K extends AugmentedRegistry<QueryRegistry>
  ? QueryRegistry[K]
  : T;

export interface PluginRegistry {
  [key: string]: Record<string, any>;
}

export type PluginName = AugmentedRegistry<PluginRegistry> extends never
  ? string
  : AugmentedRegistry<PluginRegistry>;

export type PluginRoutes<P extends PluginName> =
  P extends AugmentedRegistry<PluginRegistry>
    ? AugmentedRegistry<PluginRegistry[P]>
    : string;

export type RouteResponse<
  P extends PluginName,
  R extends PluginRoutes<P>,
> = P extends keyof PluginRegistry
  ? R extends keyof PluginRegistry[P]
    ? PluginRegistry[P][R]
    : unknown
  : unknown;
