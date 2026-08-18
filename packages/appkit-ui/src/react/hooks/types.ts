import type { Table } from "apache-arrow";
import type { MetricViewColumnDisplay } from "shared";

// ============================================================================
// Data Format Types
// ============================================================================

/**
 * Supported response formats for analytics queries.
 *
 * "JSON" and "ARROW" are legacy aliases kept for backwards compatibility
 * with appkit/appkit-ui < 0.33.0 — safe to remove once no consumer is on
 * a pre-0.33.0 version.
 */
export type AnalyticsFormat =
  | "JSON_ARRAY"
  | "ARROW_STREAM"
  /** @deprecated Use "JSON_ARRAY". Safe to remove once no consumer is on appkit-ui < 0.33.0. */
  | "JSON"
  /** @deprecated Use "ARROW_STREAM". Safe to remove once no consumer is on appkit-ui < 0.33.0. */
  | "ARROW";

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
export interface UseAnalyticsQueryOptions<
  F extends AnalyticsFormat = "JSON_ARRAY",
> {
  /** Response format - "JSON_ARRAY" (default) returns typed arrays, "ARROW_STREAM" uses Arrow (inline or external links) */
  format?: F;

  /** Maximum size of serialized parameters in bytes */
  maxParametersSize?: number;

  /** Whether to automatically start the query when the hook is mounted. Default is true. */
  autoStart?: boolean;
}

/**
 * SQL warehouse lifecycle state surfaced by `useAnalyticsQuery`.
 * Mirrors the states emitted by the analytics plugin (which mirror the
 * Databricks SQL SDK `sql.State`).
 */
export type WarehouseState =
  | "RUNNING"
  | "STARTING"
  | "STOPPED"
  | "STOPPING"
  | "DELETED"
  | "DELETING";

/**
 * Snapshot of warehouse readiness streamed by the analytics route before the
 * SQL result. Useful for rendering "warehouse starting…" affordances during
 * cold starts instead of a frozen spinner.
 *
 * Note: the SDK's `health.summary` is intentionally NOT included on the wire
 * — it's free-form operator-oriented diagnostic text (cluster IDs, capacity
 * reasons, internal RPC errors) that must not reach end users; it stays in
 * server-side telemetry only.
 */
export interface WarehouseStatus {
  state: WarehouseState;
  /** Milliseconds elapsed since the route began waiting for the warehouse. */
  elapsedMs: number;
}

/** Result state returned by useAnalyticsQuery */
export interface UseAnalyticsQueryResult<T> {
  /** Latest query result data */
  data: T | null;
  /** Loading state of the query */
  loading: boolean;
  /** Error state of the query — sanitized human-readable message */
  error: string | null;
  /**
   * Structured upstream error code when the server attaches one to the
   * error payload (e.g. `RESULT_TOO_LARGE_FOR_JSON_FALLBACK`,
   * `ARROW_DELIVERY_UNSUPPORTED`, `NOT_IMPLEMENTED`). Prefer branching UI
   * on this stable identifier rather than substring-matching `error`,
   * which is a free-form sanitized message.
   */
  errorCode: string | null;
  /**
   * Latest warehouse status emitted by the server while waiting for the SQL
   * warehouse to reach RUNNING. `null` until the first status event arrives;
   * remains `null` for cache hits where the server skips the readiness check.
   */
  warehouseStatus: WarehouseStatus | null;
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
export type QueryKey =
  AugmentedRegistry<QueryRegistry> extends never
    ? string
    : AugmentedRegistry<QueryRegistry>;

/**
 * Infers result type from QueryRegistry[K]["result"]
 * Returns the JSON array type for the query.
 */
export type InferResult<T, K> =
  K extends AugmentedRegistry<QueryRegistry>
    ? QueryRegistry[K] extends { result: infer R }
      ? R
      : T
    : T;

/**
 * Infers the row type from a query result array.
 * Used for TypedArrowTable row typing.
 */
export type InferRowType<K> =
  K extends AugmentedRegistry<QueryRegistry>
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
export type InferResultByFormat<T, K, F extends AnalyticsFormat> = F extends
  | "ARROW_STREAM"
  | "ARROW"
  ? TypedArrowTable<InferRowType<K>>
  : InferResult<T, K>;

/**
 * Infers parameters type from QueryRegistry[K]["parameters"]
 */
export type InferParams<K> =
  K extends AugmentedRegistry<QueryRegistry>
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
// AI Search
// ============================================================================

export type AiSearchQueryType = "ann" | "hybrid" | "full_text";

/** One configured index, as exposed by the ai-search plugin's `clientConfig()`. */
export interface AiSearchIndexSummary {
  alias: string;
  queryType: AiSearchQueryType;
  pagination: boolean;
}

/** Shape of the ai-search plugin's client config on `window.__appkit__`. */
export interface AiSearchClientConfig {
  indexes: AiSearchIndexSummary[];
}

export interface AiSearchRequest {
  queryText?: string;
  queryVector?: number[];
  columns?: string[];
  numResults?: number;
  queryType?: AiSearchQueryType;
  filters?: Record<string, string | number | boolean | (string | number)[]>;
  reranker?: boolean;
}

export interface AiSearchResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  score: number;
  data: T;
}

export interface AiSearchResponse<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  results: AiSearchResult<T>[];
  totalCount: number;
  queryTimeMs: number;
  queryType: AiSearchQueryType;
  nextPageToken: string | null;
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
// oxlint-disable-next-line typescript/no-empty-object-type -- intentionally empty — populated via module augmentation
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

// ============================================================================
// Metric View Registry
// ============================================================================

/** Metric view registry for type-safe metric keys */
// oxlint-disable-next-line typescript/no-empty-object-type -- intentionally empty — populated via module augmentation
export interface MetricRegistry {}

export type MetricKey =
  AugmentedRegistry<MetricRegistry> extends never
    ? string
    : AugmentedRegistry<MetricRegistry>;

export type InferMeasureKeys<K> =
  K extends AugmentedRegistry<MetricRegistry>
    ? MetricRegistry[K] extends { measureKeys: infer M }
      ? M
      : string
    : string;

export type InferDimensionKeys<K> =
  K extends AugmentedRegistry<MetricRegistry>
    ? MetricRegistry[K] extends { dimensionKeys: infer D }
      ? D
      : string
    : string;

export type InferTimeGrains<K> =
  K extends AugmentedRegistry<MetricRegistry>
    ? MetricRegistry[K] extends { timeGrains: infer G }
      ? G
      : string
    : string;

/**
 * Infers the full row shape (every measure + dimension) from registry
 * otherwise a total `Record<string, unknown>`.
 */
export type InferMetricRow<K> =
  K extends AugmentedRegistry<MetricRegistry>
    ? MetricRegistry[K] extends {
        measures: infer Meas;
        dimensions: infer Dim;
      }
      ? Meas & Dim
      : Record<string, unknown>
    : Record<string, unknown>;

export type PickMetricRow<
  K,
  M extends ReadonlyArray<PropertyKey>,
  D extends ReadonlyArray<PropertyKey>,
> =
  K extends AugmentedRegistry<MetricRegistry>
    ? MetricRegistry[K] extends {
        measures: infer Meas;
        dimensions: infer Dim;
      }
      ? Pick<Meas, Extract<M[number], keyof Meas>> &
          Pick<Dim, Extract<D[number], keyof Dim>>
      : Record<string, unknown>
    : Record<string, unknown>;

type MetricDimensionMeta<K> =
  K extends AugmentedRegistry<MetricRegistry>
    ? MetricRegistry[K] extends { metadata: { dimensions: infer DM } }
      ? DM
      : never
    : never;

/**
 * The dimension keys of K that are TEMPORAL — i.e. carry a `time_grain` tuple in
 * the generated metadata. Only these can be a `timeDimension`.
 * Degrades to `string` for an unknown key.
 */
export type InferTimeDimensionKeys<K> =
  K extends AugmentedRegistry<MetricRegistry>
    ? {
        [P in keyof MetricDimensionMeta<K>]: MetricDimensionMeta<K>[P] extends {
          time_grain: unknown;
        }
          ? P
          : never;
      }[keyof MetricDimensionMeta<K>]
    : string;

/**
 * The valid grains for the SELECTED temporal dimensions `D` of K — the union of
 * each selected temporal dimension's `time_grain` tuple. In practice grains are
 * type-driven (all `timestamp` dims share one set, all `date` dims another), so
 * the union is exactly the grains applicable to the query. Falls back to the
 * metric's whole `timeGrains` union (or `string`) for an unknown/degraded key.
 */
export type GrainsForSelectedTimeDims<K, D extends ReadonlyArray<PropertyKey>> =
  K extends AugmentedRegistry<MetricRegistry>
    ? {
        [P in Extract<
          D[number],
          keyof MetricDimensionMeta<K>
        >]: MetricDimensionMeta<K>[P] extends {
          time_grain: infer G extends readonly unknown[];
        }
          ? G[number]
          : never;
      }[Extract<D[number], keyof MetricDimensionMeta<K>>]
    : string;

export type {
  MetricFilter,
  MetricFilterOperatorName,
  MetricOrderBy,
  MetricOrderDirection,
  MetricPredicate,
  MetricViewColumnDisplay,
} from "@/js";

import type { MetricFilter, MetricOrderBy } from "@/js";

/**
 * Options for configuring a `useMetricView` query.
 *
 * Generic over the selected measure tuple `M` and dimension tuple `D` so the
 * returned row shape ({@link PickMetricRow}) narrows to exactly the columns the
 * query asked for. `timeDimension` must be a SELECTED, TEMPORAL dimension, and
 * `timeGrain` is correlated to the grains valid for those dimensions — so
 * bucketing a non-temporal dimension is a type error. `orderBy` is constrained
 * to SELECTED measures and dimensions, so ordering by an unselected column is a
 * compile-time error.
 */
type MetricViewTimeOptions<
  K extends MetricKey,
  D extends ReadonlyArray<InferDimensionKeys<K>>,
> =
  | {
      timeGrain?: undefined;
      timeDimension?: Extract<D[number], InferTimeDimensionKeys<K>>;
    }
  | {
      timeGrain: GrainsForSelectedTimeDims<K, D>;
      timeDimension: Extract<D[number], InferTimeDimensionKeys<K>>;
    };

export type UseMetricViewOptions<
  K extends MetricKey = MetricKey,
  M extends ReadonlyArray<InferMeasureKeys<K>> = ReadonlyArray<
    InferMeasureKeys<K>
  >,
  D extends ReadonlyArray<InferDimensionKeys<K>> = ReadonlyArray<
    InferDimensionKeys<K>
  >,
> = {
  measures: M;
  dimensions?: D;
  filter?: MetricFilter;
  orderBy?: ReadonlyArray<MetricOrderBy<M[number] | D[number]>>;
  limit?: number;
  /** Whether to automatically start the metric query. Default is true. */
  autoStart?: boolean;
} & MetricViewTimeOptions<K, D>;

export interface UseMetricViewResult<T = Record<string, unknown>[]> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Structured upstream error code, mirroring useAnalyticsQuery. */
  errorCode: string | null;
  /** Per-column display metadata for the queried columns, carried in the SSE result payload. `undefined` when the server injected no metadata (dormant / unknown key). */
  metadata: Record<string, MetricViewColumnDisplay> | undefined;
  /**
   * Latest warehouse status emitted while waiting for the SQL warehouse to
   * reach RUNNING. `null` until the current request receives a status event.
   */
  warehouseStatus: WarehouseStatus | null;
}
