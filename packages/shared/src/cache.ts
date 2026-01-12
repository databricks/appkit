import type { ObservabilityOptions } from "./plugin";

/** Cache entry interface */
export interface CacheEntry<T = any> {
  value: T;
  expiry: number;
}

/**
 * Cache storage interface for custom implementations
 * - InMemoryStorage
 * - PersistentStorage (Lakebase)
 */
export interface CacheStorage {
  /** Get a cached value from the storage */
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  /** Set a value in the storage */
  set<T>(key: string, entry: CacheEntry<T>): Promise<void>;
  /** Delete a value from the storage */
  delete(key: string): Promise<void>;
  /** Clear the storage */
  clear(): Promise<void>;
  /** Check if a value exists in the storage */
  has(key: string): Promise<boolean>;
  /** Get the size of the storage */
  size(): Promise<number>;
  /** Check if the storage is persistent */
  isPersistent(): boolean;
  /** Check if the storage is healthy */
  healthCheck(): Promise<boolean>;
  /** Close the storage */
  close(): Promise<void>;
}

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
  /** Cache Storage provider instance */
  storage?: CacheStorage;
  /** Whether to enforce strict persistence */
  strictPersistence?: boolean;
  /** Observability configuration */
  observability?: ObservabilityOptions;

  /** Probability (0-1) of triggering cleanup on each get operation */
  cleanupProbability?: number;

  /** Probability (0-1) of checking total bytes on each write operation */
  evictionCheckProbability?: number;

  /** Maximum number of bytes per entry in the cache */
  maxEntryBytes?: number;

  [key: string]: unknown;
}
