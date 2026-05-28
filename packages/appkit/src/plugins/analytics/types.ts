import type { BasePluginConfig } from "shared";

export interface IAnalyticsConfig extends BasePluginConfig {
  timeout?: number;
}

/**
 * Supported response formats for analytics queries.
 *
 * "JSON" and "ARROW" are legacy aliases kept for backwards compatibility
 * with appkit/appkit-ui < 0.33.0 — safe to remove once no consumer is on
 * a pre-0.33.0 version. The route handler normalizes them to their
 * canonical equivalents before any downstream code reads the value.
 */
export type AnalyticsFormat =
  | "JSON_ARRAY"
  | "ARROW_STREAM"
  /** @deprecated Use "JSON_ARRAY". Safe to remove once no consumer is on appkit < 0.33.0. */
  | "JSON"
  /** @deprecated Use "ARROW_STREAM". Safe to remove once no consumer is on appkit < 0.33.0. */
  | "ARROW";

export interface IAnalyticsQueryRequest {
  parameters?: Record<string, any>;
  format?: AnalyticsFormat;
  /**
   * Opt out of TaskFlow for this single call. Wire shape is unchanged
   * (`{ type, ...flat }` either way). No dedup, no recovery, no
   * cooperative stop. Useful for sub-500ms hot paths where WAL +
   * spawn overhead dominates. Defaults to `false`.
   */
  direct?: boolean;
}

export interface AnalyticsQueryResponse {
  chunk_index: number;
  row_offset: number;
  row_count: number;
  data: any[];
}
