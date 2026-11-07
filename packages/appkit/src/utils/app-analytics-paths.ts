/**
 * Paths App Analytics owns on the AppKit server. This module has no imports so
 * that request filters (tracing, wide events, request metrics) can use it
 * without depending on the server plugin.
 */

/**
 * Same-origin path that the App Analytics browser SDK
 * (`@databricks/app-analytics`) posts OTLP/HTTP JSON log batches to by default.
 */
export const APP_ANALYTICS_PATH = "/_analytics/v1/logs";

/**
 * Prefix of the versioned paths App Analytics serves. AppKit keeps requests
 * under it out of its own spans, wide events, and request metrics, because they
 * carry only the browser's records. It is matched at the start of the path
 * only, so app routes such as `/api/reports/_analytics/summary` keep their
 * telemetry.
 */
const APP_ANALYTICS_PATH_PREFIX = "/_analytics/v1/";

/** Whether `path` (without a query string) is served by App Analytics. */
export function isAppAnalyticsPath(path: string): boolean {
  return path.startsWith(APP_ANALYTICS_PATH_PREFIX);
}
