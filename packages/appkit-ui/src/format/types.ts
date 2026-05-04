/**
 * Library-agnostic semantic-metadata types used by the format utilities and
 * the `useMetricView` hook's `metadata` return field.
 *
 * Lives in `@databricks/appkit-ui/format` — no React dependency, no SSE
 * dependency. The shape mirrors the build-time `metrics.metadata.json`
 * artifact one-for-one so consumers can typecheck against the file they
 * imported without an extra cast.
 *
 * Source of truth: the YAML 1.1 metric-view spec on Unity Catalog. Every
 * field except `type` is optional in the YAML, so every consumer is required
 * to defend against absence (the format utilities all have sensible
 * fallbacks; the hook returns `null` when the bundle has not been registered).
 */

/**
 * Printf-style format spec sourced from a YAML 1.1 metric view. The framework
 * forwards the verbatim string — we deliberately do not invent a format DSL.
 *
 * Examples (from the UC metric-view docs):
 *  - `"$#,##0.00"` — currency with two decimals (`"$1,234.56"`)
 *  - `"0.0%"`      — percentage with one decimal (`"42.7%"`)
 *  - `"#,##0"`     — integer with thousands separator (`"1,234"`)
 *  - `"0.000"`     — fixed-precision number (`"1.235"`)
 *
 * Unrecognized specs fall back to localized number formatting (`formatValue`)
 * or identity (`toD3Format`).
 */
export type FormatSpec = string;

/**
 * Per-column metadata as emitted into the build-time bundle and returned by
 * the hook. Mirrors {@link MetricColumnMetadata} in
 * `@databricks/appkit-ui/react` — duplicated here because format utilities
 * must not import from the React subpath.
 */
export interface ColumnMetadata {
  /** Databricks SQL type ("STRING", "DECIMAL(38,2)", "TIMESTAMP", ...). */
  type: string;
  /** YAML 1.1 `display_name` — used by `formatLabel` as the canonical title. */
  display_name?: string;
  /** YAML 1.1 `format` spec — printf-style passthrough. */
  format?: FormatSpec;
  /** Column-level documentation. */
  description?: string;
  /** Allowed time-grains (only present on time-typed dimensions). */
  time_grain?: readonly string[];
}

/**
 * One metric's complete semantic-metadata bundle.
 *
 * Top-level matches the shape in the build-time `metrics.metadata.json` file:
 * `Record<metricKey, MetricMetadata>`. Each entry carries per-column metadata
 * for measures and dimensions — display names, format specs, descriptions,
 * time-grain hints. Server-side concerns (UC FQN, execution lane) live in
 * `metric.json` and are deliberately NOT part of this artifact: it ships to
 * the client.
 */
export interface MetricMetadata {
  measures: Record<string, ColumnMetadata>;
  dimensions: Record<string, ColumnMetadata>;
}

/**
 * The full registered metadata bundle.
 *
 * Top-level keys are metric keys; each entry is a {@link MetricMetadata} for
 * one metric. Pass the imported JSON to `registerMetricsMetadata()` once at
 * app startup; the hook reads it back on every render via a stable lookup.
 */
export type MetricsMetadataBundle = Record<string, MetricMetadata>;
