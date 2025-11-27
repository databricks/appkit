import { createHash } from "node:crypto";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import type { CacheConfig } from "shared";
import { LakebaseConnector } from "../connectors";
import type { Counter, ITelemetry } from "../telemetry";
import { SpanStatusCode, TelemetryManager } from "../telemetry";
import { deepMerge } from "../utils";
import { cacheDefaults } from "./defaults";
import {
  type CacheStorage,
  InMemoryStorage,
  PersistentStorage,
} from "./storage";

export type { CacheEntry, CacheStorage } from "./storage";

/**
 * Cache manager class to handle cache operations.
 * Can be used with in-memory storage or persistent storage (Lakebase).
 *
 * The cache is automatically initialized by AppKit. Use `getInstanceSync()` to access
 * the singleton instance after initialization.
 *
 * @example
 * ```typescript
 * const cache = CacheManager.getInstanceSync();
 * const result = await cache.getOrExecute(["users", userId], () => fetchUser(userId), userKey);
 * ```
 */
export class CacheManager {
  private static readonly CLEANUP_PROBABILITY = 0.01;
  private static readonly NAME: string = "cache-manager";
  private static instance: CacheManager | null = null;
  private static initPromise: Promise<CacheManager> | null = null;

  private storage: CacheStorage;
  private config: CacheConfig;
  private inFlightRequests: Map<string, Promise<unknown>>;
  private cleanupInProgress: boolean;

  // Telemetry
  private telemetry: ITelemetry;
  private cacheHitCounter: Counter;
  private cacheMissCounter: Counter;

  private constructor(
    storage: CacheStorage,
    config: CacheConfig,
    telemetry: ITelemetry,
  ) {
    this.storage = storage;
    this.config = config;
    this.inFlightRequests = new Map();
    this.cleanupInProgress = false;

    this.telemetry = telemetry;
    const meter = this.telemetry.getMeter({
      name: CacheManager.NAME,
      includePrefix: true,
    });

    this.cacheHitCounter = meter.createCounter("cache.hit", {
      description: "Total number of cache hits",
      unit: "1",
    });
    this.cacheMissCounter = meter.createCounter("cache.miss", {
      description: "Total number of cache misses",
      unit: "1",
    });
  }

  /**
   * Get the singleton instance of the cache manager (sync version).
   * Throws if not initialized - ensure AppKit.create() has completed first.
   * @returns CacheManager instance
   */
  static getInstanceSync(): CacheManager {
    if (!CacheManager.instance) {
      throw new Error(
        "CacheManager not initialized. Ensure AppKit.create() has completed before accessing the cache.",
      );
    }

    return CacheManager.instance;
  }

  /**
   * Initialize and get the singleton instance of the cache manager.
   * Called internally by AppKit - prefer `getInstanceSync()` for plugin access.
   * @param userConfig - User configuration for the cache manager
   * @returns CacheManager instance
   * @internal
   */
  static async getInstance(
    userConfig?: Partial<CacheConfig>,
  ): Promise<CacheManager> {
    if (CacheManager.instance) {
      return CacheManager.instance;
    }

    if (!CacheManager.initPromise) {
      CacheManager.initPromise = CacheManager.create(userConfig).then(
        (instance) => {
          CacheManager.instance = instance;
          return instance;
        },
      );
    }

    return CacheManager.initPromise;
  }

  /**
   * Create a new cache manager instance
   * @param userConfig - User configuration for the cache manager
   * @returns CacheManager instance
   */
  private static async create(
    userConfig?: Partial<CacheConfig>,
  ): Promise<CacheManager> {
    const config = deepMerge(cacheDefaults, userConfig);
    const telemetry = TelemetryManager.getProvider(CacheManager.NAME);

    if (!config.persistentCache) {
      return new CacheManager(new InMemoryStorage(config), config, telemetry);
    }

    try {
      const workspaceClient = new WorkspaceClient({});
      const connector = new LakebaseConnector({ workspaceClient });
      const isHealthy = await connector.healthCheck();

      if (isHealthy) {
        const persistentStorage = new PersistentStorage(config, connector);
        await persistentStorage.initialize();
        return new CacheManager(persistentStorage, config, telemetry);
      }
    } catch (error) {
      console.warn("[Cache] Persistent storage unavailable:", error);
    }

    // if strict persistence is enabled, do not fallback to in-memory storage
    if (config.strictPersistence) {
      console.warn(
        "[Cache] strictPersistence enabled but persistent storage unavailable. Cache disabled.",
      );
      const disabledConfig = { ...config, enabled: false };
      return new CacheManager(
        new InMemoryStorage(disabledConfig),
        disabledConfig,
        telemetry,
      );
    }

    console.warn("[Cache] Falling back to in-memory cache.");
    return new CacheManager(new InMemoryStorage(config), config, telemetry);
  }

  /**
   * Get or execute a function and cache the result
   * @param key - Cache key
   * @param fn - Function to execute
   * @param userKey - User key
   * @param options - Options for the cache
   * @returns Promise of the result
   */
  async getOrExecute<T>(
    key: (string | number | object)[],
    fn: () => Promise<T>,
    userKey: string,
    options?: { ttl?: number },
  ): Promise<T> {
    if (!this.config.enabled) return fn();

    const cacheKey = this.generateKey(key, userKey);

    return this.telemetry.startActiveSpan(
      "cache.getOrExecute",
      {
        attributes: {
          "cache.key": cacheKey,
          "cache.enabled": this.config.enabled,
          "cache.persistent": this.storage.isPersistent(),
        },
      },
      async (span) => {
        try {
          // Check cache first
          const cached = await this.storage.get<T>(cacheKey);
          if (cached !== null) {
            span.setAttribute("cache.hit", true);
            span.setStatus({ code: SpanStatusCode.OK });
            this.cacheHitCounter.add(1, { "cache.key": cacheKey });
            return cached.value as T;
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
            span.end();
            return inFlight as Promise<T>;
          }

          // Cache miss - execute function
          span.setAttribute("cache.hit", false);
          span.addEvent("cache.miss", { "cache.key": cacheKey });
          this.cacheMissCounter.add(1, { "cache.key": cacheKey });

          const promise = fn()
            .then(async (result) => {
              await this.set(cacheKey, result, options);
              span.addEvent("cache.value_stored", {
                "cache.key": cacheKey,
                "cache.ttl": options?.ttl ?? this.config.ttl ?? 3600,
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
      { name: CacheManager.NAME, includePrefix: true },
    );
  }

  /**
   * Get a cached value
   * @param key - Cache key
   * @returns Promise of the value or null if not found or expired
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.config.enabled) return null;

    // probabilistic cleanup trigger
    this.maybeCleanup();

    const entry = await this.storage.get<T>(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      await this.storage.delete(key);
      return null;
    }
    return entry.value as T;
  }

  /** Probabilistically trigger cleanup of expired entries (fire-and-forget) */
  private maybeCleanup(): void {
    if (this.cleanupInProgress) return;
    if (!this.storage.isPersistent()) return;
    if (Math.random() > CacheManager.CLEANUP_PROBABILITY) return;

    this.cleanupInProgress = true;
    (this.storage as PersistentStorage)
      .cleanupExpired()
      .catch((error) => {
        console.debug("Error cleaning up expired entries:", error);
      })
      .finally(() => {
        this.cleanupInProgress = false;
      });
  }

  /**
   * Set a value in the cache
   * @param key - Cache key
   * @param value - Value to set
   * @param options - Options for the cache
   * @returns Promise of the result
   */
  async set<T>(
    key: string,
    value: T,
    options?: { ttl?: number },
  ): Promise<void> {
    if (!this.config.enabled) return;

    const ttl = options?.ttl ?? this.config.ttl ?? 3600;
    const expiryTime = Date.now() + ttl * 1000;
    await this.storage.set(key, { value, expiry: expiryTime });
  }

  /**
   * Delete a value from the cache
   * @param key - Cache key
   * @returns Promise of the result
   */
  async delete(key: string): Promise<void> {
    if (!this.config.enabled) return;
    await this.storage.delete(key);
  }

  /** Clear the cache */
  async clear(): Promise<void> {
    await this.storage.clear();
    this.inFlightRequests.clear();
  }

  /**
   * Check if a value exists in the cache
   * @param key - Cache key
   * @returns Promise of true if the value exists, false otherwise
   */
  async has(key: string): Promise<boolean> {
    if (!this.config.enabled) return false;

    const entry = await this.storage.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiry) {
      await this.storage.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Generate a cache key
   * @param parts - Parts of the key
   * @param userKey - User key
   * @returns Cache key
   */
  generateKey(parts: (string | number | object)[], userKey: string): string {
    const allParts = [userKey, ...parts];
    const serialized = JSON.stringify(allParts);
    return createHash("sha256").update(serialized).digest("hex");
  }

  /** Close the cache */
  async close(): Promise<void> {
    await this.storage.close();
  }

  /**
   * Check if the storage is healthy
   * @returns Promise of true if the storage is healthy, false otherwise
   */
  async isStorageHealthy(): Promise<boolean> {
    return this.storage.healthCheck();
  }
}
