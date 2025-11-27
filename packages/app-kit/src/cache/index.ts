import type { CacheConfig } from "shared";
import type { ITelemetry } from "../telemetry";
import { type Counter, SpanStatusCode } from "../telemetry";

export interface CacheEntry<T = any> {
  value: T;
  expiry: number;
}

export class CacheManager {
  private static readonly TELEMETRY_INSTRUMENT_CONFIG = {
    name: "cache-manager",
    includePrefix: true,
  };
  private static readonly DEFAULT_ENABLED = true;
  private static readonly DEFAULT_TTL = 3600; // 1 hour
  private static readonly DEFAULT_MAX_SIZE = 1000; // default max 1000 entries

  private cache = new Map<string, CacheEntry>();
  private accessOrder = new Map<string, number>();
  private accessCounter = 0;
  private config: Required<CacheConfig>;
  private inFlightRequests = new Map<string, Promise<any>>();
  private telemetry: ITelemetry;

  // Create metrics once at class level
  private cacheHitCounter: Counter;
  private cacheMissCounter: Counter;

  constructor(config: CacheConfig = {}, telemetry: ITelemetry) {
    this.config = {
      enabled: config.enabled ?? CacheManager.DEFAULT_ENABLED,
      ttl: config.ttl ?? CacheManager.DEFAULT_TTL,
      maxSize: config.maxSize ?? CacheManager.DEFAULT_MAX_SIZE,
      cacheKey: config.cacheKey ?? [],
    };
    this.telemetry = telemetry;
    const meter = this.telemetry.getMeter(
      CacheManager.TELEMETRY_INSTRUMENT_CONFIG,
    );
    this.cacheHitCounter = meter.createCounter("cache.hit", {
      description: "Total number of cache hits",
      unit: "1",
    });
    this.cacheMissCounter = meter.createCounter("cache.miss", {
      description: "Total number of cache misses",
      unit: "1",
    });
  }

  // Get or execute a function and cache the result
  async getOrExecute<T>(
    key: (string | number | object)[],
    fn: () => Promise<T>,
    userKey: string,
    options?: { ttl?: number },
  ): Promise<T> {
    const cacheKey = this.generateKey(key, userKey);

    return this.telemetry.startActiveSpan(
      "cache.getOrExecute",
      {
        attributes: {
          "cache.key": cacheKey,
          "cache.enabled": this.config.enabled,
        },
      },
      async (span) => {
        try {
          // Check cache first
          const cached = this.get<T>(cacheKey);
          if (cached) {
            span.setAttribute("cache.hit", true);
            span.setStatus({ code: SpanStatusCode.OK });
            this.cacheHitCounter.add(1, { "cache.key": cacheKey });
            return cached;
          }

          // Check in-flight requests for deduplication
          const inFlight = this.inFlightRequests.get(cacheKey);
          if (inFlight) {
            span.setAttribute("cache.hit", true);
            span.setAttribute("cache.deduplication", true);
            span.addEvent("cache.deduplication_used", {
              "cache.key": cacheKey,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            this.cacheHitCounter.add(1, {
              "cache.key": cacheKey,
              "cache.deduplication": "true",
            });
            return inFlight;
          }

          // Cache miss - execute function
          span.setAttribute("cache.hit", false);
          span.addEvent("cache.miss", { "cache.key": cacheKey });
          this.cacheMissCounter.add(1, { "cache.key": cacheKey });

          const promise = fn()
            .then((result) => {
              this.set(cacheKey, result, options);
              span.addEvent("cache.value_stored", {
                "cache.key": cacheKey,
                "cache.ttl": options?.ttl ?? this.config.ttl,
              });
              return result;
            })
            .catch((error) => {
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            })
            .finally(() => {
              this.inFlightRequests.delete(cacheKey);
            });

          this.inFlightRequests.set(cacheKey, promise);

          const result = await promise;
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
      CacheManager.TELEMETRY_INSTRUMENT_CONFIG,
    );
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

    // Update access order for LRU
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
    this.inFlightRequests.clear();
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

  generateKey(parts: (string | number | object)[], userKey: string): string {
    parts = [userKey, ...parts];
    return parts.map((p) => JSON.stringify(p)).join(":");
  }

  // Evict the least recently used entry (LRU)
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
