/**
 * Shared analytics plugin route definitions.
 *
 * Single source of truth for analytics endpoints used by both:
 * - app-kit (server-side AnalyticsPlugin)
 * - app-kit-ui (client-side analyticsApi)
 */

// ============================================================================
// Route Definitions
// ============================================================================

/**
 * Analytics plugin route paths.
 * These are relative to the plugin base path (/api/analytics/).
 */
export const analyticsRoutes = {
  query: "/query/:query_key",
  queryAsUser: "/users/me/query/:query_key",
  arrowResult: "/arrow-result/:jobId",
} as const;

// ============================================================================
// Type Utilities for Path Parameter Extraction
// ============================================================================

/**
 * Extract all path parameter names from a URL template.
 * Handles both mid-path and end-of-path parameters.
 *
 * e.g., "/users/:userId/posts/:postId" -> "userId" | "postId"
 */
type ExtractPathParams<T extends string> =
  T extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractPathParams<`/${Rest}`>
    : T extends `${string}:${infer Param}`
      ? Param
      : never;

/**
 * Convert a union of parameter names to an object type with string values.
 * e.g., "userId" | "postId" -> { userId: string; postId: string }
 */
type ParamsToObject<T extends string> = [T] extends [never]
  ? Record<string, never>
  : { [K in T]: string };

/**
 * Extract path parameters from a URL template as an object type.
 * e.g., "/query/:query_key" -> { query_key: string }
 */
export type PathParams<T extends string> = ParamsToObject<ExtractPathParams<T>>;

// ============================================================================
// Analytics Endpoint Parameter Types (derived from routes)
// ============================================================================

/**
 * Type-safe parameter definitions for each analytics endpoint.
 * Automatically derived from the route path templates.
 */
export type AnalyticsEndpointParams = {
  [K in keyof typeof analyticsRoutes]: PathParams<(typeof analyticsRoutes)[K]>;
};

// Verify the types are correct (these are compile-time checks)
// AnalyticsEndpointParams should be:
// {
//   query: { query_key: string };
//   queryAsUser: { query_key: string };
//   arrowResult: { jobId: string };
// }
