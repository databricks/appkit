import type { MetricViewColumnDisplay, MetricViewsMetadata } from "shared";

/**
 * Flatten the injected {@link MetricViewsMetadata} for `key` into a single
 * `Record<column, meta>` covering only the requested measures and dimensions,
 * so the client can label/format just the columns it queried.
 *
 * Pure response decoration: it never touches the cache key or the SQL, and
 * reads only from the injected value (never disk / DESCRIBE at runtime).
 *
 * Lookups go through {@link Object.hasOwn}, so neither an inherited metric key
 * nor an inherited column name (`toString`, `__proto__`, …) can resolve to a
 * bogus entry. Requested columns absent from the metadata are omitted rather
 * than placeheld.
 *
 * Returns `undefined` rather than an empty object when there is nothing to
 * stamp, so the caller can omit the field and keep the message byte-identical
 * to a plain `/query` result.
 */
export function selectMetricMetadata(
  all: MetricViewsMetadata | undefined,
  key: string,
  measures: string[],
  dimensions: string[] | undefined,
): Record<string, MetricViewColumnDisplay> | undefined {
  if (!all || !Object.hasOwn(all, key)) {
    return undefined;
  }

  const entry = all[key];
  const slice: Record<string, MetricViewColumnDisplay> = {};

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
