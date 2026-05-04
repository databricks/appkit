// AUTO-GENERATED from metric-source.schema.json — do not edit.
// Run: pnpm exec tsx tools/generate-schema-types.ts
/**
 * Metric key. Must be a valid identifier (letters, digits, underscores; cannot start with a digit). Becomes the route key in POST /api/analytics/metric/:key, the hook argument in useMetricView('<key>', ...), and the MetricRegistry augmentation key.
 *
 * This interface was referenced by `MetricSourceConfiguration`'s JSON-Schema
 * via the `definition` "metricKey".
 */
export type MetricKey = string;

/**
 * Schema for AppKit metric.json — declares Unity Catalog Metric View sources for the analytics plugin's metric-view path. Each entry under sp/obo binds a metric key to a UC metric view FQN. Object form (rather than bare string) at v1 enables future per-entry option growth without breaking changes.
 */
export interface MetricSourceConfiguration {
  /**
   * Reference to the JSON Schema for validation
   */
  $schema?: string;
  /**
   * Metric views queried as the service principal. Cache scope is shared across all users.
   */
  sp?: {
    [k: string]: MetricEntry;
  };
  /**
   * Metric views queried as the requesting user (on-behalf-of). Cache scope is per-user.
   */
  obo?: {
    [k: string]: MetricEntry;
  };
}
/**
 * A single metric view source declaration. v1 only accepts the 'source' field; future per-entry options (cacheTtl, defaultFilter, allowlists) ship as additive properties.
 *
 * This interface was referenced by `MetricSourceConfiguration`'s JSON-Schema
 * via the `definition` "metricEntry".
 */
export interface MetricEntry {
  /**
   * Three-part Unity Catalog FQN of the metric view: <catalog>.<schema>.<metric_view>
   */
  source: string;
}
