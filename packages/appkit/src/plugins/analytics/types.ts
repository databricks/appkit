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

/** Canonical (post-normalization) analytics format values. */
type CanonicalAnalyticsFormat = "JSON_ARRAY" | "ARROW_STREAM";

/**
 * Map a (possibly legacy) AnalyticsFormat to its canonical form.
 * Legacy values come from appkit/appkit-ui < 0.33.0 and can be removed
 * along with the deprecated aliases once no such consumer remains.
 */
export function normalizeAnalyticsFormat(
  f: AnalyticsFormat,
): CanonicalAnalyticsFormat {
  if (f === "JSON") return "JSON_ARRAY";
  if (f === "ARROW") return "ARROW_STREAM";
  return f;
}

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
