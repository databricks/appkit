/**
 * Endpoints utility for accessing backend API routes.
 *
 * Provides a clean way to build API URLs with parameter substitution,
 * reading from the runtime config injected by the server.
 */

import type { AnalyticsEndpointParams } from "shared";

// Re-export for consumers
export type { AnalyticsEndpointParams } from "shared";

/** Map of endpoint names to their path templates for a plugin */
export type PluginEndpointMap = Record<string, string>;

/** Map of plugin names to their endpoint maps */
export type PluginEndpoints = Record<string, PluginEndpointMap>;

export interface RuntimeConfig {
  appName: string;
  queries: Record<string, string>;
  endpoints: PluginEndpoints;
}

declare global {
  interface Window {
    __CONFIG__?: RuntimeConfig;
  }
}

/**
 * Get the runtime config from the window object.
 */
export function getConfig(): RuntimeConfig {
  if (!window.__CONFIG__) {
    throw new Error(
      "Runtime config not found. Make sure the server is injecting __CONFIG__.",
    );
  }
  return window.__CONFIG__;
}

/**
 * Substitute path parameters in a URL template.
 *
 * @param template - URL template with :param placeholders
 * @param params - Parameters to substitute
 * @returns The resolved URL
 */
function substituteParams(
  template: string,
  params: Record<string, string | number> = {},
): string {
  let resolved = template;
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`:${key}`, encodeURIComponent(String(value)));
  }
  return resolved;
}

/**
 * Append query parameters to a URL.
 */
function appendQueryParams(
  url: string,
  queryParams: Record<string, string | number | boolean> = {},
): string {
  if (Object.keys(queryParams).length === 0) return url;

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(queryParams)) {
    searchParams.set(key, String(value));
  }
  return `${url}?${searchParams.toString()}`;
}

type UrlParams = Record<string, string | number>;
type QueryParams = Record<string, string | number | boolean>;

/**
 * Create a plugin API that reads endpoints from runtime config.
 *
 * @param pluginName - Plugin name to look up in config
 * @returns Proxy object with endpoint methods
 *
 * @example
 * ```typescript
 * const analytics = createPluginApi("analytics");
 *
 * // Access named endpoint
 * analytics.query({ query_key: "spend_data" })
 * // → "/api/analytics/query/spend_data"
 *
 * // With query params
 * analytics.query({ query_key: "test" }, { dev: "tunnel-123" })
 * // → "/api/analytics/query/test?dev=tunnel-123"
 * ```
 */
export function createPluginApi(pluginName: string) {
  return new Proxy(
    {},
    {
      get(_target, endpointName: string) {
        return (params: UrlParams = {}, queryParams: QueryParams = {}) => {
          const config = getConfig();
          const pluginEndpoints = config.endpoints[pluginName];

          if (!pluginEndpoints) {
            throw new Error(
              `Plugin "${pluginName}" not found in endpoints config`,
            );
          }

          const template = pluginEndpoints[endpointName];
          if (!template) {
            throw new Error(
              `Endpoint "${endpointName}" not found for plugin "${pluginName}"`,
            );
          }

          const url = substituteParams(template, params);
          return appendQueryParams(url, queryParams);
        };
      },
    },
  ) as Record<
    string,
    (params?: UrlParams, queryParams?: QueryParams) => string
  >;
}

/**
 * Build a URL directly from a path template.
 *
 * @example
 * ```typescript
 * buildUrl("/api/analytics/query/:query_key", { query_key: "spend_data" })
 * // → "/api/analytics/query/spend_data"
 * ```
 */
export function buildUrl(
  template: string,
  params: UrlParams = {},
  queryParams: QueryParams = {},
): string {
  const url = substituteParams(template, params);
  return appendQueryParams(url, queryParams);
}

/** Base endpoint function type */
export type EndpointFn<TParams = UrlParams> = (
  params?: TParams,
  queryParams?: QueryParams,
) => string;

/** Default plugin API shape (all endpoints accept any params) */
export type DefaultPluginApi = Record<string, EndpointFn>;

/**
 * Augmentable interface for typed plugin APIs.
 *
 * Apps can extend this interface to get type-safe endpoint access.
 *
 * @example
 * ```typescript
 * // In your app's appKitTypes.d.ts:
 * declare module '@databricks/app-kit-ui' {
 *   interface AppKitPlugins {
 *     analytics: {
 *       query: EndpointFn<{ query_key: string }>;
 *       arrowResult: EndpointFn<{ jobId: string }>;
 *     };
 *     reconnect: {
 *       status: EndpointFn;
 *       stream: EndpointFn;
 *     };
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: Designed for module augmentation
export interface AppKitPlugins {}

/** Resolved API type - uses augmented types if available, otherwise defaults */
type ApiType = AppKitPlugins & Record<string, DefaultPluginApi>;

/**
 * Dynamic API helper that reads plugins from runtime config.
 *
 * Automatically synced with the plugins registered on the server.
 * Access any plugin's named endpoints directly.
 *
 * For type safety, augment the `AppKitPlugins` interface in your app.
 *
 * @example
 * ```typescript
 * // Access any plugin's endpoints (auto-discovered from server config)
 * api.analytics.query({ query_key: "spend_data" })
 * // → "/api/analytics/query/spend_data"
 *
 * api.analytics.arrowResult({ jobId: "abc123" })
 * // → "/api/analytics/arrow-result/abc123"
 *
 * api.reconnect.stream()
 * // → "/api/reconnect/stream"
 *
 * // Works with any plugin registered on the server
 * api.myCustomPlugin.myEndpoint({ id: "123" })
 * ```
 */
export const api: ApiType = new Proxy({} as ApiType, {
  get(_target, pluginName: string) {
    return createPluginApi(pluginName);
  },
});

// ============================================================================
// Pre-typed Plugin APIs for internal package use
// ============================================================================
// These helpers provide type-safe endpoint access within app-kit-ui itself,
// since the AppKitPlugins augmentation only applies in consuming apps.
// AnalyticsEndpointParams is imported from shared package (single source of truth).

/** Typed analytics API for internal package use */
export interface AnalyticsApiType {
  query: (
    params: AnalyticsEndpointParams["query"],
    queryParams?: QueryParams,
  ) => string;
  queryAsUser: (
    params: AnalyticsEndpointParams["queryAsUser"],
    queryParams?: QueryParams,
  ) => string;
  arrowResult: (
    params: AnalyticsEndpointParams["arrowResult"],
    queryParams?: QueryParams,
  ) => string;
}

/**
 * Pre-typed analytics API for use within the app-kit-ui package.
 *
 * This provides type-safe access to analytics endpoints without relying
 * on AppKitPlugins augmentation (which only works in consuming apps).
 *
 * @example
 * ```typescript
 * // Type-safe within the package
 * analyticsApi.query({ query_key: "spend_data" })
 * // → "/api/analytics/query/spend_data"
 *
 * analyticsApi.arrowResult({ jobId: "abc123" })
 * // → "/api/analytics/arrow-result/abc123"
 * ```
 */
export const analyticsApi: AnalyticsApiType = createPluginApi(
  "analytics",
) as unknown as AnalyticsApiType;
