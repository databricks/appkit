import type { BasePluginConfig } from "shared";

export interface EndpointConfig {
  /** Environment variable holding the endpoint name. */
  env: string;
  /** Target a specific served model (bypasses traffic routing). */
  servedModel?: string;
}

export interface IServingConfig extends BasePluginConfig {
  /** Map of alias → endpoint config. Defaults to { default: { env: "DATABRICKS_SERVING_ENDPOINT" } } if omitted. */
  endpoints?: Record<string, EndpointConfig>;
  /** Request timeout in ms. Default: 120000 (2 min) */
  timeout?: number;
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

/** Typed invoke/stream methods for a serving endpoint. */
export interface ServingEndpointMethods<
  TRequest extends Record<string, unknown> = Record<string, unknown>,
  TResponse = unknown,
  TChunk = unknown,
> {
  invoke: (body: TRequest) => Promise<TResponse>;
  stream: (body: TRequest) => AsyncGenerator<TChunk>;
}

/** Factory function type — typed when registry is populated, untyped fallback otherwise. */
export type ServingFactory = keyof ServingEndpointRegistry extends never
  ? (alias?: string) => ServingEndpointMethods
  : <K extends keyof ServingEndpointRegistry>(
      alias: K,
    ) => ServingEndpointMethods<
      ServingEndpointRegistry[K]["request"],
      ServingEndpointRegistry[K]["response"],
      ServingEndpointRegistry[K]["chunk"]
    >;
