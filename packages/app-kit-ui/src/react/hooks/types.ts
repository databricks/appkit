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
 *     apps_list: {
 *       name: "apps_list";
 *       parameters: { startDate: string; endDate: string; aggregationLevel: string };
 *       result: Array<{ id: string; name: string }>;
 *     };
 *   }
 * }
 * ```
 */
export interface QueryRegistry {
  [key: string]: {
    name: string;
    parameters: Record<string, unknown>;
    result: unknown[];
  };
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
 * Infers result type from QueryRegistry[K]["result"]
 */
export type InferResult<T, K> = K extends AugmentedRegistry<QueryRegistry>
  ? QueryRegistry[K] extends { result: infer R }
    ? R
    : T
  : T;

/**
 * Infers parameters type from QueryRegistry[K]["parameters"]
 */
export type InferParams<K> = K extends AugmentedRegistry<QueryRegistry>
  ? QueryRegistry[K] extends { parameters: infer P }
    ? P
    : Record<string, unknown>
  : Record<string, unknown>;

export interface PluginRegistry {
  [key: string]: Record<string, any>;
}
