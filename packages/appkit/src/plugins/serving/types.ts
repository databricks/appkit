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
 * Empty base — augmented by the type generator's `.d.ts` output via module augmentation.
 */
export interface ServingEndpointRegistry {
  [key: string]: {
    request: Record<string, unknown>;
    response: unknown;
    chunk: unknown;
  };
}
