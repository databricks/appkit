/**
 * Library-agnostic format utilities for UC Metric View consumption.
 *
 * Phase 5 of `prd/analytics-metric-view-source.md` ships these so customers
 * can wire metric metadata into Plotly / ECharts / table cells / KPI tiles
 * without an AppKit-specific chart-prop lock-in.
 *
 * Three primary functions:
 *  - {@link formatValue} — turns a raw value + format spec into a display string.
 *  - {@link formatLabel} — returns `display_name` from metadata, falls back to humanized column name.
 *  - {@link toD3Format} — converts UC printf-style specs to d3-format strings.
 *
 * Plus a registration API for the build-time metadata bundle:
 *  - {@link registerMetricsMetadata} — call once at app startup with the
 *    imported `metrics.metadata.json`.
 *  - {@link getMetricMetadata} — used by `useMetricView` (and any custom
 *    glue code) to read per-metric metadata back out.
 */

export { formatLabel, formatValue, toD3Format } from "./format";
export {
  _getRegisteredBundleForTesting,
  clearMetricsMetadata,
  getMetricMetadata,
  registerMetricsMetadata,
} from "./registry";
export type {
  ColumnMetadata,
  FormatSpec,
  MetricMetadata,
  MetricsMetadataBundle,
} from "./types";
