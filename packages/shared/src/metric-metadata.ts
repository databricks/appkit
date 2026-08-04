/** Per-column display metadata for a UC Metric View column, sourced from the
 *  YAML 1.1 display_name/format attributes + SQL type. Loose enough that an
 *  `as const` generated literal assigns to it. */
export interface MetricColumnMeta {
  type: string;
  display_name?: string;
  format?: string;
  description?: string;
}
/** Build-time-generated metadata for every registered metric view, keyed by
 *  metric key. Injected into the analytics plugin via `analytics({ metricViewsMetadata })`. */
export type MetricViewsMetadata = Record<
  string,
  {
    measures: Record<string, MetricColumnMeta>;
    dimensions: Record<string, MetricColumnMeta>;
  }
>;
