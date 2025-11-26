import type { CacheConfig } from "shared";
import { inMemoryStorageDefaults } from "./defaults";
import type { CacheEntry, CacheStorage } from "./types";

/**
 * In-memory cache storage implementation. Uses a least recently used (LRU) eviction policy
 * to manage memory usage and ensure efficient cache operations.
 */
export class InMemoryStorage implements CacheStorage {
  private cache: Map<string, CacheEntry> = new Map();
  private accessOrder: Map<string, number> = new Map();
  private accessCounter: number;
  private maxSize: number;

  constructor(config: CacheConfig) {
    this.cache = new Map();
    this.accessOrder = new Map();
    this.maxSize = config.maxSize ?? inMemoryStorageDefaults.maxSize;
    this.accessCounter = 0;
  }

  /** Get an entry from the cache */
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    this.accessOrder.set(key, ++this.accessCounter);
    return entry as CacheEntry<T>;
  }

  /** Set an entry in the cache */
  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, entry);
    this.accessOrder.set(key, ++this.accessCounter);
  }

  /** Delete an entry from the cache */
  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    this.accessOrder.delete(key);
  }

  /** Clean in-memory cache */
  async clear(): Promise<void> {
    this.cache.clear();
    this.accessOrder.clear();
    this.accessCounter = 0;
  }

  /** Check if the cache has an entry */
  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.accessOrder.delete(key);
      return false;
    }

    return true;
  }

  /** Get the size of the cache */
  async size(): Promise<number> {
    return this.cache.size;
  }

  /** Check if the cache is persistent */
  isPersistent(): boolean {
    return false;
  }

  /** Check the health of the cache */
  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Close the cache */
  async close(): Promise<void> {
    this.cache.clear();
    this.accessOrder.clear();
    this.accessCounter = 0;
  }

  /** Evict the least recently used entry (LRU) */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, accessTime] of this.accessOrder) {
      if (accessTime < oldestAccess) {
        oldestAccess = accessTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.accessOrder.delete(oldestKey);
    }
  }
}
