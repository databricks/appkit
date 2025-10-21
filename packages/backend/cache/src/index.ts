import type { CacheConfig } from "@databricks-apps/types";

export interface CacheEntry<T = any> {
  value: T;
  expiry: number;
}

export class CacheManager {
  private cache = new Map<string, CacheEntry>();
  private accessOrder = new Map<string, number>();
  private accessCounter = 0;
  private config: Required<CacheConfig>;
  private inFlightRequests = new Map<string, Promise<any>>();

  constructor(config: CacheConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      ttl: config.ttl ?? 3600, // 1 hour
      maxSize: config.maxSize ?? 1000, // default max 1000 entries
      cacheKey: config.cacheKey ?? [],
    };
  }

  // get or execute a function and cache the result
  async getOrExecute<T>(
    key: (string | number | object)[],
    fn: () => Promise<T>,
    userToken?: string,
    options?: { ttl?: number },
  ): Promise<T> {
    const cacheKey = this.generateKey(key, userToken);

    // check cache first
    const cached = this.get<T>(cacheKey);
    if (cached) {
      return cached;
    }

    // check in flight requests for deduplication
    const inFlight = this.inFlightRequests.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = fn()
      .then((result) => {
        this.set(cacheKey, result, options);
        return result;
      })
      .finally(() => {
        this.inFlightRequests.delete(cacheKey);
      });

    this.inFlightRequests.set(cacheKey, promise);
    return promise;
  }

  get<T>(key: string): T | null {
    if (!this.config.enabled) return null;

    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.accessOrder.delete(key);
      return null;
    }

    // update access order for LRU
    this.accessOrder.set(key, ++this.accessCounter);
    return entry.value as T;
  }

  set<T>(key: string, value: T, options?: { ttl?: number }): void {
    if (!this.config.enabled) return;

    if (this.cache.size >= this.config.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    const expiryTime = Date.now() + (options?.ttl ?? this.config.ttl) * 1000;
    this.cache.set(key, { value, expiry: expiryTime });
    this.accessOrder.set(key, ++this.accessCounter);
  }

  delete(key: string): void {
    this.cache.delete(key);
    this.accessOrder.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder.clear();
    this.accessCounter = 0;
  }

  has(key: string): boolean {
    if (!this.config.enabled) return false;
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.accessOrder.delete(key);
      return false;
    }
    return true;
  }

  generateKey(parts: (string | number | object)[], userToken?: string): string {
    if (userToken) {
      parts = [userToken, ...parts];
    }
    return parts.map((p) => JSON.stringify(p)).join(":");
  }

  // evict the least recently used entry (LRU)
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
