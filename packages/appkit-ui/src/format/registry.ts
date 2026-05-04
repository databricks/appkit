import type { MetricMetadata, MetricsMetadataBundle } from "./types";

/**
 * In-memory store for the build-time-bundled metric semantic metadata.
 *
 * The `metrics.metadata.json` artifact emitted by the AppKit type-generator
 * is opt-in: the consuming app imports it and calls
 * {@link registerMetricsMetadata} once at startup (typically in the same
 * module that mounts the React tree). The `useMetricView` hook reads from
 * this store on every render via {@link getMetricMetadata}; the returned
 * object reference is stable across re-renders for the same metric key.
 *
 * The store is process-global by design — the metadata is inert data
 * (display names, format specs, descriptions) and there is no per-user or
 * per-request variation. Using a module-level singleton keeps the surface
 * minimal: the customer touches this once, the hook reads it many times.
 */
let registeredBundle: MetricsMetadataBundle | null = null;

/**
 * Register the build-time semantic-metadata bundle for the running app.
 *
 * Typical usage at app startup:
 *
 * ```ts
 * import metricsMetadata from "../shared/appkit-types/metrics.metadata.json";
 * import { registerMetricsMetadata } from "@databricks/appkit-ui/format";
 *
 * registerMetricsMetadata(metricsMetadata);
 * ```
 *
 * Calling this multiple times replaces the previous bundle — useful in dev
 * mode if the type-generator regenerates the file mid-session, but the hook
 * is intentionally not reactive to bundle changes (the metadata is
 * build-time-frozen at deploy by the PRD's contract). Tests reset between
 * runs via {@link clearMetricsMetadata}.
 */
export function registerMetricsMetadata(
  bundle: MetricsMetadataBundle | null,
): void {
  registeredBundle = bundle ?? null;
}

/**
 * Retrieve the metadata for one registered metric.
 *
 * Returns `null` when:
 *  - no bundle has been registered (the app didn't opt into the metadata flow), or
 *  - the bundle has no entry for `metricKey` (typo / out-of-sync registration).
 *
 * The returned object is a direct reference into the registered bundle —
 * {@link useMetricView} relies on this for stable identity across re-renders.
 * Callers must not mutate it.
 */
export function getMetricMetadata(metricKey: string): MetricMetadata | null {
  if (registeredBundle == null) return null;
  const entry = registeredBundle[metricKey];
  return entry ?? null;
}

/**
 * Test-only seam: reset the registry between tests so leftover state from a
 * previous test cannot affect the next one. Production code never calls this.
 *
 * @internal
 */
export function clearMetricsMetadata(): void {
  registeredBundle = null;
}

/**
 * Test-only seam: introspect the registered bundle.
 *
 * @internal
 */
export function _getRegisteredBundleForTesting(): MetricsMetadataBundle | null {
  return registeredBundle;
}
