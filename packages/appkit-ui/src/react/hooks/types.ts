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
// Metric View Registry (Phase 2 — measures + dimensions + time grain)
// ============================================================================

/**
 * Metric View Registry — populated via TypeScript module augmentation by the
 * AppKit type-generator (parallel to {@link QueryRegistry}).
 *
 * Each registered metric key contributes an entry whose shape carries the
 * FQN, lane, the structured measure / dimension lists harvested from the
 * build-time DESCRIBE TABLE EXTENDED ... AS JSON call, and (Phase 5) the
 * per-column semantic metadata bundle (display name, format spec,
 * description, time-grain options).
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
 *       dimensions: { region: string; created_at: string };
 *       measureKeys: "arr" | "mrr";
 *       dimensionKeys: "region" | "created_at";
 *       timeGrains: "day" | "week" | "month";
 *       metadata: {
 *         measures: {
 *           arr: { type: "DECIMAL(38,2)"; display_name: "Annual Recurring Revenue"; format: "$#,##0.00" };
 *           mrr: { type: "DECIMAL(38,2)" };
 *         };
 *         dimensions: {
 *           region: { type: "STRING" };
 *           created_at: { type: "TIMESTAMP"; time_grain: readonly ["day", "week", "month"] };
 *         };
 *       };
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

/**
 * The union of allowed time-grains for a registered metric key — derived from
 * the YAML 1.1 `time_grain` attributes on time-typed dimensions. Resolves to
 * `string` for unregistered keys (so dynamic callers don't compile-error) and
 * to `never` for registered metrics that have zero time-typed dimensions.
 */
export type TimeGrain<K> = K extends AugmentedRegistry<MetricRegistry>
  ? MetricRegistry[K] extends { timeGrains: infer G }
    ? G extends string
      ? G
      : never
    : never
  : string;

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

// ============================================================================
// Metric View Semantic Metadata (Phase 5 — display names, format specs, ...)
// ============================================================================

/**
 * The per-column semantic-metadata shape exposed via `useMetricView`'s
 * `metadata` return field and `formatLabel` / `formatValue`'s second argument.
 *
 * Mirrors the `metrics.metadata.json` build-time artifact one-for-one. Every
 * field except `type` is optional — the YAML 1.1 metric view spec marks them
 * as opt-in, so the consumer's chart code defends against absence (e.g.
 * `formatLabel` falls back to camelCase humanization when `display_name` is
 * absent).
 */
export interface MetricColumnMetadata {
  /** Databricks SQL type ("STRING", "DECIMAL(38,2)", "TIMESTAMP", ...). */
  type: string;
  /** YAML 1.1 `display_name` — used by `formatLabel` as the canonical title. */
  display_name?: string;
  /**
   * YAML 1.1 `format` — printf-style spec (`"$#,##0.00"`, `"0.0%"`, etc).
   * Consumed by `formatValue` (returns formatted string) and `toD3Format`
   * (returns d3-format-compatible string for Plotly's `tickformat` /
   * ECharts' `valueFormatter`).
   */
  format?: string;
  /** Column-level documentation, surfaced in tooltips by chart components. */
  description?: string;
  /**
   * Allowed time-grains (only present on time-typed dimensions). Phase 2
   * widening: lets the call-site narrow `timeGrain` to the dim's allowed list.
   */
  time_grain?: readonly string[];
}

/**
 * One metric's complete semantic-metadata bundle.
 *
 * Mirrors the entry shape inside `metrics.metadata.json`. Returned verbatim
 * by `useMetricView<K>` in its `metadata` field — TypeScript narrows
 * `metadata.measures.<measureKey>` and `metadata.dimensions.<dimKey>` from the
 * registry's per-metric `metadata` augmentation when `K` is a registered key.
 */
export interface MetricSemanticMetadata {
  source: string;
  lane: "sp" | "obo";
  measures: Record<string, MetricColumnMetadata>;
  dimensions: Record<string, MetricColumnMetadata>;
}

/**
 * Type-narrowed metadata for a registered metric `K`.
 *
 * When `K` is a registered key, resolves to the registry's `metadata` shape
 * (per-column literal-typed `display_name` / `format` / `time_grain`). When
 * `K` is `string` (no augmentation), resolves to the structural
 * {@link MetricSemanticMetadata}.
 *
 * Consumers usually destructure: `metadata.measures.arr.format`,
 * `metadata.dimensions.created_at.time_grain`, etc.
 */
export type MetricMetadata<K> = K extends AugmentedRegistry<MetricRegistry>
  ? MetricRegistry[K] extends { metadata: infer Meta }
    ? Meta
    : MetricSemanticMetadata
  : MetricSemanticMetadata;

// ============================================================================
// Filter Specification (Phase 3 — recursive AND/OR with 12 v1 operators)
// ============================================================================

/**
 * The v1 filter operator vocabulary. Twelve operators, exactly:
 *
 *  - Equality:        `equals`, `notEquals`
 *  - Set membership:  `in`, `notIn`
 *  - Range:           `gt`, `gte`, `lt`, `lte`
 *  - String search:   `contains`, `notContains`
 *  - NULL checks:     `set`, `notSet`
 *
 * Operator-vs-type rules (enforced server-side):
 *  - Range ops (`gt`, `gte`, `lt`, `lte`) require a numeric / date-typed dim.
 *  - String ops (`contains`, `notContains`) require a string-typed dim.
 *  - The remaining six accept any dimension type.
 *
 * Cardinality rules (enforced server-side):
 *  - Single-value ops (`equals`, `notEquals`, `gt`, `gte`, `lt`, `lte`,
 *    `contains`, `notContains`) require exactly one value.
 *  - List ops (`in`, `notIn`) require at least one value.
 *  - NULL ops (`set`, `notSet`) reject `values` entirely.
 */
export type MetricFilterOperator =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "notContains"
  | "set"
  | "notSet";

/**
 * A single filter predicate — leaf node of the recursive {@link Filter} tree.
 *
 * `member` narrows to the union of dimension names declared on the metric
 * view (HAVING — filtering on measures — is reserved for v1.5).
 *
 * `values` is optional; the validator rejects requests where `values` is
 * present for `set`/`notSet` and absent for every other operator.
 */
export interface Predicate<K> {
  member: DimensionKey<K>;
  operator: MetricFilterOperator;
  values?: ReadonlyArray<string | number>;
}

/**
 * The recursive filter type for metric views.
 *
 * A `Filter<K>` is one of:
 *  - a leaf {@link Predicate}
 *  - an `{ and: Filter<K>[] }` group — every child predicate must match
 *  - an `{ or: Filter<K>[] }` group — at least one child predicate must match
 *
 * The shape supports nesting from v1; flat consumers can pass an array of
 * predicates either via `{ and: [...] }` (explicit AND) or — since the wire
 * shape carries the full union — by composing a single-level `{ and }`
 * wrapper on the client.
 *
 * Server-side, recursion is depth-capped so a malformed or hostile payload
 * cannot stack-overflow the validator.
 */
export type Filter<K> =
  | Predicate<K>
  | { and: ReadonlyArray<Filter<K>> }
  | { or: ReadonlyArray<Filter<K>> };

/**
 * Phase 2 args: measures + dimensions + optional time grain.
 *
 * Generics:
 *  - `K` — the metric key (narrows to the registry literal at the call site).
 *  - `M` — the chosen measure tuple (narrows to the literal subset).
 *  - `D` — the chosen dimension tuple (narrows to the literal subset).
 *
 * Use `const` modifiers on `M` and `D` at the call site for literal-preserving
 * inference (matches the Phase 1 measures-only pattern):
 *
 * ```tsx
 * useMetricView("revenue", {
 *   measures: ["arr"] as const,
 *   dimensions: ["region", "created_at"] as const,
 *   timeGrain: "month",
 * });
 * ```
 */
export interface UseMetricViewArgs<
  K extends MetricKey,
  M extends ReadonlyArray<MeasureKey<K>> = ReadonlyArray<MeasureKey<K>>,
  D extends ReadonlyArray<DimensionKey<K>> = ReadonlyArray<DimensionKey<K>>,
> {
  measures: M;
  /**
   * Dimensions to GROUP BY. Empty (or omitted) → ungrouped query. Only
   * dimensions declared on the metric view are accepted.
   */
  dimensions?: D;
  /**
   * Time-grain truncation applied to every time-typed dimension in
   * `dimensions`. Narrows to the union of grains the metric view declares.
   *
   * If the metric view has no time-typed dimensions, this field cannot be set
   * (the type resolves to `never`).
   *
   * Setting `timeGrain` without including any time-typed dimension in
   * `dimensions` is a server-side 400.
   */
  timeGrain?: TimeGrain<K>;
  /**
   * Optional structured filter — recursive AND/OR composition of predicates.
   *
   * `member` narrows to the metric's declared dimension names (the IDE
   * catches typos at the call site). `operator` narrows to the 12 v1
   * operators. All `values` are bound as parameters server-side; nothing
   * from the request body flows into the rendered SQL string.
   *
   * The filter shape is recursive from day one — flat callers can wrap a
   * predicate list in `{ and: [...] }`; nested callers can mix `and`/`or`
   * groups freely. The server enforces a depth cap to prevent stack abuse.
   */
  filter?: Filter<K>;
  /** Optional row cap. */
  limit?: number;
}

/**
 * Row narrowing helper: produce the row type containing only the chosen
 * measures and dimensions, matching what the server projects.
 *
 * If callers omit dimensions, the row contains only measures; if callers omit
 * measures (not allowed at v1, but the type stays sound), the row contains
 * only dimensions.
 */
export type UseMetricViewRow<
  K extends MetricKey,
  M extends ReadonlyArray<MeasureKey<K>>,
  D extends ReadonlyArray<DimensionKey<K>>,
> = Pick<MetricRow<K>, (M[number] | D[number]) & keyof MetricRow<K>>;

/** Phase 2 options: format passthrough + autoStart toggle. */
export interface UseMetricViewOptions<F extends AnalyticsFormat = "JSON"> {
  format?: F;
  /** Whether to fire the request automatically on mount. Default: true. */
  autoStart?: boolean;
  /** Maximum size of the serialized request body in bytes. Default: 100 KiB. */
  maxParametersSize?: number;
}

/**
 * Phase 5 result shape: `{ data, metadata, loading, error }`.
 *
 * `metadata` is the build-time-bundled semantic metadata for the queried
 * metric (measures + dimensions only — not other metrics in the registry).
 * It is available **before** the data loads (it comes from the build-time
 * artifact, not the network) and is stable across re-renders for the same
 * metric key (the runtime registry returns the same object reference).
 *
 * When the consuming app has not registered the metadata bundle (via
 * `registerMetricsMetadata` in `@databricks/appkit-ui/format`), `metadata`
 * resolves to `null`. The PRD's contract is "available even when data is
 * null" — but the bundle itself is opt-in, so a `null` here is the
 * unregistered-app signal.
 */
export interface UseMetricViewResult<TRow, TMetadata = MetricSemanticMetadata> {
  data: TRow[] | null;
  metadata: TMetadata | null;
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
