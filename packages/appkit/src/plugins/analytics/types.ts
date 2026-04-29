import type { BasePluginConfig } from "shared";

export interface IAnalyticsConfig extends BasePluginConfig {
  timeout?: number;
}

export type AnalyticsFormat = "JSON" | "ARROW";
export interface IAnalyticsQueryRequest {
  parameters?: Record<string, any>;
  format?: AnalyticsFormat;
}

export interface AnalyticsQueryResponse {
  chunk_index: number;
  row_offset: number;
  row_count: number;
  data: any[];
}

/**
 * Lane an entry sits in inside metric.json. SP = service principal (shared
 * cache), OBO = on-behalf-of (per-user cache).
 */
export type MetricLane = "sp" | "obo";

/**
 * Resolved metric-view registration loaded at server startup.
 *
 * The registration carries the FQN (used by the SQL constructor) plus the
 * known measure/dimension names produced by the build-time DESCRIBE call
 * (used by the body validator to reject unknown measures fast).
 */
export interface MetricRegistration {
  /** Stable map key from metric.json. */
  key: string;
  /** Three-part Unity Catalog FQN of the metric view. */
  source: string;
  /** Lane this metric was registered under. */
  lane: MetricLane;
  /**
   * Names of measures known at build time. Empty array means "unknown" — the
   * server falls open in that case and the warehouse rejects bad column
   * references.
   */
  knownMeasures: string[];
  /**
   * Names of dimensions known at build time. Phase 2 consumes this for
   * dimension validation and `GROUP BY ALL` emission.
   */
  knownDimensions: string[];
  /**
   * Map of dimension name → allowed time-grains for that dimension. Only
   * populated for time-typed dimensions (those with a `time_grain` attribute
   * in the YAML); regular dimensions do not appear in this map.
   *
   * Empty map means "no time-typed dimensions" — `timeGrain` cannot be set
   * on requests for this metric.
   */
  knownTimeGrainsByDim: Record<string, string[]>;
}

/**
 * Body of POST /api/analytics/metric/:key at Phase 2.
 *
 * Phase 1 shape: `{ measures, format?, limit? }`. Phase 2 widens with
 * `dimensions: string[]` and optional `timeGrain`. Phase 3 will add `filter`.
 */
export interface IAnalyticsMetricRequest {
  measures: string[];
  /**
   * Dimensions to GROUP BY. When non-empty the SQL constructor adds
   * `GROUP BY ALL`. When omitted the query is ungrouped (Phase 1 behaviour).
   */
  dimensions?: string[];
  /**
   * Time-grain truncation applied to every time-typed dimension in
   * `dimensions`. The validator rejects this field when no time-typed
   * dimension is in `dimensions` (400) and when the value is not in the
   * metric view's allowed grain enum (400).
   */
  timeGrain?: string;
  format?: AnalyticsFormat;
  /** Optional row cap. */
  limit?: number;
}
