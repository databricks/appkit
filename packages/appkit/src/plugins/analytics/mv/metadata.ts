import type { MetricViewColumnDisplay, MetricViewsMetadata } from "shared";
import {
  METRIC_METADATA_BUNDLE_VERSION,
  METRIC_METADATA_FILE,
  metricMetadataBundleSchema,
} from "../../../../../shared/src/schemas/metric-metadata-bundle";
import type { AppManager, DevFileReader, RequestLike } from "../../../app";
import { createLogger } from "../../../logging/logger";

const logger = createLogger("analytics:metric-views");

// Re-exported so analytics-local callers name the bundle through this module
// rather than reaching into `shared` for the basename.
export { METRIC_METADATA_FILE };

/**
 * Parsed-bundle cache, keyed on the raw file contents. Validation is the
 * expensive half of the load (the read is a small local file, and going through
 * {@link AppManager.readMetricViewsConfig} is what keeps it dev-tunnel-aware),
 * so re-reading per request while reusing the parse both stays correct when a
 * developer edits the bundle and avoids re-validating on every metric query.
 */
let parsedBundleCache: { raw: string; metadata: MetricViewsMetadata } | null =
  null;

/**
 * Read `config/metric-views/metadata.generated.json` into per-column display
 * metadata, or `undefined` when there is none to stamp.
 *
 * The runtime twin of the generated `MetricRegistry` augmentation: the type
 * generator emits both from one `DESCRIBE` pass, this side being JSON so the
 * plugin can discover it instead of the app importing and injecting it.
 *
 * Read through {@link AppManager.readMetricViewsConfig} for the same reasons as
 * {@link loadMetricRegistry} — dev-tunnel awareness and the traversal guard.
 *
 * **Never throws.** Unlike `definitions.json`, whose absence or corruption must
 * fail the request (no source means no query), this bundle is pure response
 * decoration. A missing or malformed file degrades to unlabeled columns, which
 * is strictly better than failing a query that would otherwise have succeeded.
 * Absent → silent (the metric path is simply un-generated); malformed or
 * version-mismatched → warn, so the cause is visible in logs.
 */
export async function loadMetricMetadata(
  app: AppManager,
  req?: RequestLike,
  devFileReader?: DevFileReader,
): Promise<MetricViewsMetadata | undefined> {
  let raw: string | null;
  try {
    raw = await app.readMetricViewsConfig(
      METRIC_METADATA_FILE,
      req,
      devFileReader,
    );
  } catch (err) {
    logger.warn(
      "Failed to read %s: %s",
      METRIC_METADATA_FILE,
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }

  // Absent file (ENOENT / dev-tunnel not-found) or a rejected traversal path.
  // Types were never generated, or generation predates the bundle → dormant.
  if (raw === null) {
    return undefined;
  }

  if (parsedBundleCache?.raw === raw) {
    return parsedBundleCache.metadata;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      "Ignoring malformed %s: %s",
      METRIC_METADATA_FILE,
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }

  const result = metricMetadataBundleSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      "Ignoring invalid %s: %s",
      METRIC_METADATA_FILE,
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
    return undefined;
  }

  if (result.data.version !== METRIC_METADATA_BUNDLE_VERSION) {
    logger.warn(
      "Ignoring %s written for bundle version %d (this runtime reads version %d) — regenerate types",
      METRIC_METADATA_FILE,
      result.data.version,
      METRIC_METADATA_BUNDLE_VERSION,
    );
    return undefined;
  }

  // Null-prototype map for the same reason as the registry: a metric key that
  // collides with an inherited `Object.prototype` member must not resolve to a
  // truthy non-entry at the lookup site in `selectMetricMetadata`.
  const metadata: MetricViewsMetadata = Object.create(null);
  for (const [key, entry] of Object.entries(result.data.metricViews)) {
    metadata[key] = entry;
  }

  parsedBundleCache = { raw, metadata };
  return metadata;
}

/**
 * Flatten the resolved {@link MetricViewsMetadata} for `key` into a single
 * `Record<column, meta>` covering only the requested measures and dimensions,
 * so the client can label/format just the columns it queried.
 *
 * Pure response decoration: it never touches the cache key or the SQL, and
 * reads only from the already-resolved value (never DESCRIBE at runtime).
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
