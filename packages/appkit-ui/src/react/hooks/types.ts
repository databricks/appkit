import type { Table } from "apache-arrow";

// ============================================================================
// Data Format Types
// ============================================================================

/** Supported response formats for analytics queries */
export type AnalyticsFormat = "JSON" | "ARROW";

/**
 * Typed Arrow Table - preserves row type information for type inference.
 * At runtime this is just a regular Arrow Table, but TypeScript knows the row schema.
 *
 * @example
 * ```typescript
 * type MyTable = TypedArrowTable<{ id: string; value: number }>;
 * // Can access table.getChild("id") knowing it exists
 * ```
 */
export interface TypedArrowTable<
  TRow extends Record<string, unknown> = Record<string, unknown>,
> extends Table {
  /**
   * Phantom type marker for row schema.
   * Not used at runtime - only for TypeScript type inference.
   */
  readonly __rowType?: TRow;
}

// ============================================================================
// Query Options & Result Types
// ============================================================================

/** Options for configuring an analytics SSE query */
export interface UseAnalyticsQueryOptions<F extends AnalyticsFormat = "JSON"> {
  /** Response format - "JSON" returns typed arrays, "ARROW" returns TypedArrowTable */
  format?: F;

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
 * // shared/appkit-types/analytics.d.ts
 * declare module "@databricks/appkit-ui/react" {
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
 * Returns the JSON array type for the query.
 */
export type InferResult<T, K> = K extends AugmentedRegistry<QueryRegistry>
  ? QueryRegistry[K] extends { result: infer R }
    ? R
    : T
  : T;

/**
 * Infers the row type from a query result array.
 * Used for TypedArrowTable row typing.
 */
export type InferRowType<K> = K extends AugmentedRegistry<QueryRegistry>
  ? QueryRegistry[K] extends { result: Array<infer R> }
    ? R extends Record<string, unknown>
      ? R
      : Record<string, unknown>
    : Record<string, unknown>
  : Record<string, unknown>;

/**
 * Conditionally infers result type based on format.
 * - JSON format: Returns the typed array from QueryRegistry
 * - ARROW format: Returns TypedArrowTable with row type preserved
 */
export type InferResultByFormat<
  T,
  K,
  F extends AnalyticsFormat,
> = F extends "ARROW" ? TypedArrowTable<InferRowType<K>> : InferResult<T, K>;

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

export interface ServingClientConfig {
  isNamedMode: boolean;
  aliases: string[];
}

// ============================================================================
// Metric View Registry (Phase 1 — measures only)
// ============================================================================

/**
 * Metric View Registry — populated via TypeScript module augmentation by the
 * AppKit type-generator (parallel to {@link QueryRegistry}).
 *
 * Each registered metric key contributes an entry whose shape carries the
 * FQN, lane, and the structured measure / dimension lists harvested from the
 * build-time DESCRIBE TABLE EXTENDED ... AS JSON call.
 *
 * @example
 * ```ts
 * declare module "@databricks/appkit-ui/react" {
 *   interface MetricRegistry {
 *     revenue: {
 *       key: "revenue";
 *       source: "appkit_demo.public.revenue_metrics";
 *       lane: "sp";
 *       measures: { arr: number; mrr: number };
 *       dimensions: Record<string, never>;
 *       measureKeys: "arr" | "mrr";
 *       dimensionKeys: never;
 *     };
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — populated via module augmentation
export interface MetricRegistry {}

/** Resolves to MetricRegistry keys if any are populated, otherwise string. */
export type MetricKey = AugmentedRegistry<MetricRegistry> extends never
  ? string
  : AugmentedRegistry<MetricRegistry>;

/** The union of declared measure names for a registered metric key. */
export type MeasureKey<K> = K extends AugmentedRegistry<MetricRegistry>
  ? MetricRegistry[K] extends { measureKeys: infer M }
    ? M extends string
      ? M
      : string
    : string
  : string;

/** The union of declared dimension names for a registered metric key. */
export type DimensionKey<K> = K extends AugmentedRegistry<MetricRegistry>
  ? MetricRegistry[K] extends { dimensionKeys: infer D }
    ? D extends string
      ? D
      : never
    : never
  : never;

/** The "measures" entry on a registered metric — a record of name → row type. */
type MetricMeasureMap<K> = K extends AugmentedRegistry<MetricRegistry>
  ? MetricRegistry[K] extends { measures: infer M }
    ? M extends Record<string, unknown>
      ? M
      : Record<string, unknown>
    : Record<string, unknown>
  : Record<string, unknown>;

/** The "dimensions" entry on a registered metric — a record of name → row type. */
type MetricDimensionMap<K> = K extends AugmentedRegistry<MetricRegistry>
  ? MetricRegistry[K] extends { dimensions: infer D }
    ? D extends Record<string, unknown>
      ? D
      : Record<string, unknown>
    : Record<string, unknown>
  : Record<string, unknown>;

/** Full result row type for a registered metric (measures + dimensions). */
export type MetricRow<K> = MetricMeasureMap<K> & MetricDimensionMap<K>;

/** Phase 1 args: only measures are accepted. */
export interface UseMetricViewArgs<K extends MetricKey> {
  measures: ReadonlyArray<MeasureKey<K>>;
  /** Optional row cap. */
  limit?: number;
}

/** Phase 1 options: format passthrough + autoStart toggle. */
export interface UseMetricViewOptions<F extends AnalyticsFormat = "JSON"> {
  format?: F;
  /** Whether to fire the request automatically on mount. Default: true. */
  autoStart?: boolean;
  /** Maximum size of the serialized request body in bytes. Default: 100 KiB. */
  maxParametersSize?: number;
}

/** Phase 1 result shape: { data, loading, error }. */
export interface UseMetricViewResult<TRow> {
  data: TRow[] | null;
  loading: boolean;
  error: string | null;
}

// ============================================================================
// Serving Endpoint Registry
// ============================================================================

/**
 * Serving endpoint registry for type-safe alias names.
 * Extend this interface via module augmentation to get alias autocomplete:
 *
 * @example
 * ```typescript
 * // Auto-generated by appKitServingTypesPlugin()
 * declare module "@databricks/appkit-ui/react" {
 *   interface ServingEndpointRegistry {
 *     llm: { request: {...}; response: {...}; chunk: {...} };
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — populated via module augmentation
export interface ServingEndpointRegistry {}

/** Resolves to registry keys if populated, otherwise string */
export type ServingAlias =
  AugmentedRegistry<ServingEndpointRegistry> extends never
    ? string
    : AugmentedRegistry<ServingEndpointRegistry>;

/** Infers chunk type from registry when alias is a known key */
export type InferServingChunk<K> =
  K extends AugmentedRegistry<ServingEndpointRegistry>
    ? ServingEndpointRegistry[K] extends { chunk: infer C }
      ? C
      : unknown
    : unknown;

/** Infers response type from registry when alias is a known key */
export type InferServingResponse<K> =
  K extends AugmentedRegistry<ServingEndpointRegistry>
    ? ServingEndpointRegistry[K] extends { response: infer R }
      ? R
      : unknown
    : unknown;

/** Infers request type from registry when alias is a known key */
export type InferServingRequest<K> =
  K extends AugmentedRegistry<ServingEndpointRegistry>
    ? ServingEndpointRegistry[K] extends { request: infer Req }
      ? Req
      : Record<string, unknown>
    : Record<string, unknown>;
