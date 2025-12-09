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

  /** Probability (0-1) of triggering cleanup on each get operation */
  cleanupProbability?: number;

  /** Maximum number of bytes per entry in the cache */
  maxEntryBytes?: number;

  [key: string]: unknown;
}
