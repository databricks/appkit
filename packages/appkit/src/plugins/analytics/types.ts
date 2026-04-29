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
   * Names of measures known at build time. Empty array means "unknown" — at
   * Phase 1 the server falls open in that case (relies on the warehouse to
   * reject bad column references). Phase 2 tightens this.
   */
  knownMeasures: string[];
  /**
   * Names of dimensions known at build time. Phase 1 does not consume these
   * (no GROUP BY yet) but they ride along so Phase 2/3 do not need a second
   * loader.
   */
  knownDimensions: string[];
}

/**
 * Body of POST /api/analytics/metric/:key at Phase 1.
 *
 * Phase 2 widens this with `dimensions` + `timeGrain`; Phase 3 adds `filter`.
 */
export interface IAnalyticsMetricRequest {
  measures: string[];
  format?: AnalyticsFormat;
  /** Optional row cap. Phase 1 only. */
  limit?: number;
}
