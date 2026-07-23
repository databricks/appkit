import type { MetricColumnMeta, MetricViewsMetadata } from "shared";

/**
 * Compute the per-column metadata slice for a metric response, scoped to the
 * columns the request actually asked for.
 *
 * `all` is the build-generated {@link MetricViewsMetadata} the app injects via
 * `analytics({ metricViewsMetadata })` — a per-metric map of `measures` /
 * `dimensions` to their {@link MetricColumnMeta}. This flattens the requested
 * measures and dimensions for `key` into a single `Record<column, meta>` for
 * the SSE `result` message, so the client can label/format only the columns it
 * queried.
 *
 * This is pure **response decoration**: it never touches the cache key or the
 * SQL, and reads only from the injected value (never disk / DESCRIBE at runtime).
 *
 * Returns `undefined` (rather than an empty object) when there is nothing to
 * stamp — so the caller can omit the field entirely and the message stays
 * byte-identical to a plain `/query` result:
 *   - `all` is absent (no metadata injected), or
 *   - `key` is not an own property of `all` (unknown metric; uses
 *     {@link Object.hasOwn} so a prototype member like `toString` never
 *     resolves to a bogus entry), or
 *   - none of the requested columns are present in the metadata (fully
 *     degraded / unknown columns).
 *
 * Requested columns that are absent from the metadata are simply omitted — a
 * degraded/unknown column produces no entry rather than a placeholder.
 */
export function selectMetricMetadata(
  all: MetricViewsMetadata | undefined,
  key: string,
  measures: string[],
  dimensions: string[] | undefined,
): Record<string, MetricColumnMeta> | undefined {
  if (!all || !Object.hasOwn(all, key)) {
    return undefined;
  }

  const entry = all[key];
  const slice: Record<string, MetricColumnMeta> = {};

  for (const measure of measures) {
    if (Object.hasOwn(entry.measures, measure)) {
      slice[measure] = entry.measures[measure];
    }
  }
  for (const dimension of dimensions ?? []) {
    if (Object.hasOwn(entry.dimensions, dimension)) {
      slice[dimension] = entry.dimensions[dimension];
    }
  }

  return Object.keys(slice).length > 0 ? slice : undefined;
}
