export interface CacheConfig {
  enabled?: boolean;
  ttl?: number; // time to live in seconds
  maxSize?: number; // maximum number of entries in the cache
  cacheKey?: (string | number | object)[];
}
