import type { BasePluginConfig } from "shared";

export interface EndpointConfig {
  /** Environment variable holding the endpoint name. */
  env: string;
  /** Target a specific served model (bypasses traffic routing). */
  servedModel?: string;
}

export interface IServingConfig extends BasePluginConfig {
  /** Map of alias → endpoint config. Defaults to { default: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } } if omitted. */
  endpoints?: Record<string, EndpointConfig>;
  /** Request timeout in ms. Default: 120000 (2 min) */
  timeout?: number;
  /** How to handle unknown request parameters. 'strip' silently removes them (default). 'reject' returns 400. */
  filterMode?: "strip" | "reject";
}

/**
 * Registry interface for serving endpoint type generation.
 * Empty by default — augmented by the Vite type generator's `.d.ts` output via module augmentation.
 * When populated, provides autocomplete for alias names and typed request/response/chunk per endpoint.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — populated via module augmentation
export interface ServingEndpointRegistry {}

/** Shape of a single registry entry. */
export interface ServingEndpointEntry {
  request: Record<string, unknown>;
  response: unknown;
  chunk: unknown;
}

/** Typed invoke method for a serving endpoint. */
export interface ServingEndpointMethods<
  TRequest extends Record<string, unknown> = Record<string, unknown>,
  TResponse = unknown,
> {
  invoke: (body: TRequest) => Promise<TResponse>;
}

/** Endpoint handle with asUser support, returned by the exports factory. */
export type ServingEndpointHandle<
  TRequest extends Record<string, unknown> = Record<string, unknown>,
  TResponse = unknown,
> = ServingEndpointMethods<TRequest, TResponse> & {
  asUser: (
    req: import("express").Request,
  ) => ServingEndpointMethods<TRequest, TResponse>;
};

/** True when T is a union of 2+ members; false for a single literal type. */
type IsUnion<T, C = T> = T extends C ? ([C] extends [T] ? false : true) : never;

/**
 * Factory function returned by `AppKit.serving`.
 *
 * Adapts based on the `ServingEndpointRegistry` state:
 *
 * - **Empty (default):** `(alias?: string) => ServingEndpointHandle` — any string, untyped.
 * - **Single key:** alias optional — `serving()` returns the typed handle for the only endpoint.
 * - **Multiple keys:** alias required — must specify which endpoint.
 *
 * Run `npx appkit generate-types` or start the dev server to generate the registry.
 */
export type ServingFactory = keyof ServingEndpointRegistry extends never
  ? // Empty registry: accept any string, alias optional
    (alias?: string) => ServingEndpointHandle
  : true extends IsUnion<keyof ServingEndpointRegistry>
    ? // Multiple keys: alias REQUIRED for disambiguation
      <K extends keyof ServingEndpointRegistry>(
        alias: K,
      ) => ServingEndpointHandle<
        ServingEndpointRegistry[K]["request"],
        ServingEndpointRegistry[K]["response"]
      >
    : // Single key: alias optional (runtime defaults to "default")
      {
        <K extends keyof ServingEndpointRegistry>(
          alias: K,
        ): ServingEndpointHandle<
          ServingEndpointRegistry[K]["request"],
          ServingEndpointRegistry[K]["response"]
        >;
        (): ServingEndpointHandle<
          ServingEndpointRegistry[keyof ServingEndpointRegistry]["request"],
          ServingEndpointRegistry[keyof ServingEndpointRegistry]["response"]
        >;
      };
