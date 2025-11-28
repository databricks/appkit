import type { TelemetryOptions } from "./plugin";

/** Configuration for caching */
export interface CacheConfig {
  /** Whether caching is enabled */
  enabled?: boolean;
  /** Time to live in seconds */
  ttl?: number;
  /** Maximum number of bytes in the cache */
  maxBytes?: number;
  /** Maximum number of entries in the cache */
  maxSize?: number;
  /** Cache key */
  cacheKey?: (string | number | object)[];
  /** Whether to use persistent cache */
  persistentCache?: boolean;
  /** Whether to enforce strict persistence */
  strictPersistence?: boolean;
  /** Telemetry configuration */
  telemetry?: TelemetryOptions;

  [key: string]: unknown;
}
