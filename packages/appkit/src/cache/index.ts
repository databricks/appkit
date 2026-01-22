import { createHash } from "node:crypto";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import type { CacheConfig, CacheStorage } from "shared";
import { LakebaseConnector } from "@/connectors";
import { AppKitError, ExecutionError, InitializationError } from "../errors";
import { createLogger } from "../logging/logger";
import type { Counter, TelemetryProvider } from "../telemetry";
import { SpanStatusCode, TelemetryManager } from "../telemetry";
import { deepMerge } from "../utils";
import { cacheDefaults } from "./defaults";
import { InMemoryStorage, PersistentStorage } from "./storage";

const logger = createLogger("cache");

/**
 * Cache manager class to handle cache operations.
 * Can be used with in-memory storage or persistent storage (Lakebase).
 *
 * The cache is automatically initialized by AppKit. Use `getInstanceSync()` to access
 * the singleton instance after initialization.
 *
 * @internal
 * @example
 * ```typescript
 * const cache = CacheManager.getInstanceSync();
 * const result = await cache.getOrExecute(["users", userId], () => fetchUser(userId), userKey);
 * ```
 */
export class CacheManager {
  private static readonly MIN_CLEANUP_INTERVAL_MS = 60_000;
  private readonly name: string = "cache-manager";
  private static instance: CacheManager | null = null;
  private static initPromise: Promise<CacheManager> | null = null;

  private storage: CacheStorage;
  private config: CacheConfig;
  private inFlightRequests: Map<string, Promise<unknown>>;
  private cleanupInProgress: boolean;
  private lastCleanupAttempt: number;

  private telemetry: TelemetryProvider;
  private telemetryMetrics: {
    cacheHitCount: Counter;
    cacheMissCount: Counter;
  };

  private constructor(storage: CacheStorage, config: CacheConfig) {
    this.storage = storage;
    this.config = config;
    this.inFlightRequests = new Map();
    this.cleanupInProgress = false;
    this.lastCleanupAttempt = 0;

    this.telemetry = TelemetryManager.getProvider(
      this.name,
      this.config.telemetry,
    );
    this.telemetryMetrics = {
      cacheHitCount: this.telemetry.getMeter().createCounter("cache.hit", {
        description: "Total number of cache hits",
        unit: "1",
      }),
      cacheMissCount: this.telemetry.getMeter().createCounter("cache.miss", {
        description: "Total number of cache misses",
        unit: "1",
      }),
    };
  }

  /**
   * Get the singleton instance of the cache manager (sync version).
   *
   * Throws if not initialized - ensure AppKit.create() has completed first.
   * @returns CacheManager instance
   */
  static getInstanceSync(): CacheManager {
    if (!CacheManager.instance) {
      throw InitializationError.notInitialized(
        "CacheManager",
        "Ensure AppKit.create() has completed before accessing the cache",
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
   *
   * Storage selection logic:
   * 1. If `storage` provided and healthy → use provided storage
   * 2. If `storage` provided but unhealthy → fallback to InMemory (or disable if strictPersistence)
   * 3. If no `storage` provided and Lakebase available → use Lakebase
   * 4. If no `storage` provided and Lakebase unavailable → fallback to InMemory (or disable if strictPersistence)
   *
   * @param userConfig - User configuration for the cache manager
   * @returns CacheManager instance
   */
  private static async create(
    userConfig?: Partial<CacheConfig>,
  ): Promise<CacheManager> {
    const config = deepMerge(cacheDefaults, userConfig);

    if (config.storage) {
      const isHealthy = await config.storage.healthCheck();
      if (isHealthy) {
        return new CacheManager(config.storage, config);
      }

      if (config.strictPersistence) {
        const disabledConfig = { ...config, enabled: false };
        return new CacheManager(
          new InMemoryStorage(disabledConfig),
          disabledConfig,
        );
      }

      return new CacheManager(new InMemoryStorage(config), config);
    }

    // try to use lakebase storage
    try {
      const workspaceClient = new WorkspaceClient({});
      const connector = new LakebaseConnector({ workspaceClient });
      const isHealthy = await connector.healthCheck();

      if (isHealthy) {
        const persistentStorage = new PersistentStorage(config, connector);
        await persistentStorage.initialize();
        return new CacheManager(persistentStorage, config);
      }
    } catch {
      // lakebase unavailable, continue with in-memory storage
    }

    if (config.strictPersistence) {
      const disabledConfig = { ...config, enabled: false };
      return new CacheManager(
        new InMemoryStorage(disabledConfig),
        disabledConfig,
      );
    }

    return new CacheManager(new InMemoryStorage(config), config);
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
          // check if the value is in the cache
          const cached = await this.storage.get<T>(cacheKey);
          if (cached !== null) {
            span.setAttribute("cache.hit", true);
            span.setStatus({ code: SpanStatusCode.OK });
            this.telemetryMetrics.cacheHitCount.add(1, {
              "cache.key": cacheKey,
            });

            logger.event()?.setExecution({
              cache_hit: true,
              cache_key: cacheKey,
            });

            return cached.value as T;
          }

          // check if the value is being processed by another request
          const inFlight = this.inFlightRequests.get(cacheKey);
          if (inFlight) {
            span.setAttribute("cache.hit", true);
            span.setAttribute("cache.deduplication", true);
            span.addEvent("cache.deduplication_used", {
              "cache.key": cacheKey,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            this.telemetryMetrics.cacheHitCount.add(1, {
              "cache.key": cacheKey,
              "cache.deduplication": "true",
            });

            logger.event()?.setExecution({
              cache_hit: true,
              cache_key: cacheKey,
              cache_deduplication: true,
            });

            span.end();
            return inFlight as Promise<T>;
          }

          // cache miss - execute function
          span.setAttribute("cache.hit", false);
          span.addEvent("cache.miss", { "cache.key": cacheKey });
          this.telemetryMetrics.cacheMissCount.add(1, {
            "cache.key": cacheKey,
          });

          logger.event()?.setExecution({
            cache_hit: false,
            cache_key: cacheKey,
          });

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
              if (error instanceof AppKitError) {
                throw error;
              }
              throw ExecutionError.statementFailed(
                error instanceof Error ? error.message : String(error),
              );
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
      { name: this.name, includePrefix: true },
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
    const now = Date.now();
    if (now - this.lastCleanupAttempt < CacheManager.MIN_CLEANUP_INTERVAL_MS)
      return;

    const probability = this.config.cleanupProbability ?? 0.01;

    if (Math.random() > probability) return;

    this.lastCleanupAttempt = now;

    this.cleanupInProgress = true;
    (this.storage as PersistentStorage)
      .cleanupExpired()
      .catch((error) => {
        logger.debug("Error cleaning up expired entries: %O", error);
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
