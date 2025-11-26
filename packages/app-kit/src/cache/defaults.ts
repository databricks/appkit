import type { CacheConfig } from "shared";

/** Default configuration for cache */
export const cacheDefaults: CacheConfig = {
  enabled: true,
  ttl: 3600, // 1 hour
  maxSize: 1000, // 1000 entries
  cacheKey: [], // no cache key by default
  persistentCache: true, // use lakebase as persistent cache by default
  cleanupProbability: 0.01, // 1% probability of triggering cleanup on each get operation
  strictPersistence: false, // if false, use in-memory storage if lakebase is unavailable
};
