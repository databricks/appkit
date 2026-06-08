import { createHash } from "node:crypto";
import { ApiError, WorkspaceClient } from "@databricks/sdk-experimental";
import type { CacheConfig, CacheEntry, CacheStorage } from "shared";
import { createLakebasePool } from "../connectors/lakebase";
import { AppKitError, ExecutionError, InitializationError } from "../errors";
import { createLogger } from "../logging/logger";
import type { Counter, TelemetryProvider } from "../telemetry";
import { SpanStatusCode, TelemetryManager } from "../telemetry";
import { deepMerge } from "../utils";
import { cacheDefaults } from "./defaults";
import { InMemoryStorage, PersistentStorage } from "./storage";

const logger = createLogger("cache");

/**
 * Reference-counted in-flight cache execution entry.
 *
 * `sharedController` decouples the cached `fn()` from any single caller's
 * abort signal. Callers join an in-flight entry by incrementing `refCount`;
 * when a caller aborts, refCount is decremented. The shared controller is
 * aborted only when refCount drops to 0 — i.e. all callers have abandoned
 * the request. This prevents one caller's cancellation (e.g. React
 * StrictMode unmount) from poisoning the in-flight result for other still-
 * connected awaiters.
 */
interface InFlightEntry<T> {
  promise: Promise<T>;
  refCount: number;
  sharedController: AbortController;
  abortTimer?: ReturnType<typeof setTimeout>;
}

function createAbortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

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
  private static readonly ABORT_GRACE_PERIOD_MS = 100;
  private readonly name: string = "cache-manager";
  private static instance: CacheManager | null = null;
  private static initPromise: Promise<CacheManager> | null = null;

  private storage: CacheStorage;
  private config: CacheConfig;
  private inFlightRequests: Map<string, InFlightEntry<unknown>>;
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
      const pool = createLakebasePool({ workspaceClient });
      const persistentStorage = new PersistentStorage(config, pool);

      const isHealthy = await persistentStorage.healthCheck();
      if (isHealthy) {
        await persistentStorage.initialize();
        return new CacheManager(persistentStorage, config);
      }

      // Health check failed, close the pool and fallback
      await pool.end();
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
   * Get or execute a function and cache the result.
   *
   * Multiple concurrent callers with the same `cacheKey` are deduplicated
   * onto a single in-flight execution. Each caller may pass its own
   * `callerSignal`; the underlying `fn()` is run with a shared, internally
   * managed `AbortSignal` that aborts only when *all* callers have
   * abandoned the request (reference counted). This decouples a single
   * caller's cancellation (e.g. React StrictMode unmount) from the shared
   * result, so other still-connected callers receive the cached value
   * normally.
   *
   * @param key - Cache key parts
   * @param fn - Function to execute. Receives the cache-owned shared signal;
   *   pass it through to the underlying I/O so the work is cancelled when
   *   no caller is left waiting.
   * @param userKey - User key for cache namespacing
   * @param options - Options for the cache
   * @returns Promise of the result
   */
  async getOrExecute<T>(
    key: (string | number | object)[],
    fn: (sharedSignal?: AbortSignal) => Promise<T>,
    userKey: string,
    options?: { ttl?: number; callerSignal?: AbortSignal },
  ): Promise<T> {
    if (!this.config.enabled) return fn(options?.callerSignal);

    const callerSignal = options?.callerSignal;
    if (callerSignal?.aborted) {
      throw createAbortError(callerSignal);
    }

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
          const cached = await this.getValid<T>(cacheKey);
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

            return cached.value;
          }

          // check if the value is being processed by another request — join
          // the existing in-flight entry under reference counting so this
          // caller's abort doesn't poison the shared result.
          const existing = this.inFlightRequests.get(cacheKey) as
            | InFlightEntry<T>
            | undefined;
          if (existing && !existing.sharedController.signal.aborted) {
            existing.refCount++;
            // Cancel any pending abort timer — a new caller has joined
            if (existing.abortTimer) {
              clearTimeout(existing.abortTimer);
              existing.abortTimer = undefined;
            }
            span.setAttribute("cache.hit", true);
            span.setAttribute("cache.deduplication", true);
            span.addEvent("cache.deduplication_used", {
              "cache.key": cacheKey,
            });
            this.telemetryMetrics.cacheHitCount.add(1, {
              "cache.key": cacheKey,
              "cache.deduplication": "true",
            });

            logger.event()?.setExecution({
              cache_hit: true,
              cache_key: cacheKey,
              cache_deduplication: true,
            });

            return await this._waitWithRefCount(existing, callerSignal);
          }

          // cache miss - execute function under a shared abort controller
          span.setAttribute("cache.hit", false);
          span.addEvent("cache.miss", { "cache.key": cacheKey });
          this.telemetryMetrics.cacheMissCount.add(1, {
            "cache.key": cacheKey,
          });

          logger.event()?.setExecution({
            cache_hit: false,
            cache_key: cacheKey,
          });

          const sharedController = new AbortController();
          const entry: InFlightEntry<T> = {
            promise: undefined as unknown as Promise<T>,
            refCount: 1,
            sharedController,
          };

          entry.promise = fn(sharedController.signal)
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
              // If the shared controller aborted, all callers have already
              // abandoned the request (or are about to via their own signals)
              // — propagate the original error without wrapping. No live
              // awaiter will observe this rejection.
              if (sharedController.signal.aborted) {
                throw error;
              }
              if (error instanceof AppKitError || error instanceof ApiError) {
                throw error;
              }
              throw ExecutionError.statementFailed(
                error instanceof Error ? error.message : String(error),
              );
            })
            .finally(() => {
              if (this.inFlightRequests.get(cacheKey) === entry) {
                this.inFlightRequests.delete(cacheKey);
              }
            });

          // Suppress unhandled rejection warnings when every caller bailed
          // before fn() resolved (their own promises rejected via
          // waitWithRefCount; the underlying entry.promise has no awaiter).
          entry.promise.catch(() => {});

          this.inFlightRequests.set(cacheKey, entry as InFlightEntry<unknown>);

          const result = await this._waitWithRefCount(entry, callerSignal);
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
   * Wait on an in-flight entry, racing the underlying promise against the
   * caller's abort signal. When the caller aborts, the entry's refCount is
   * decremented; if it hits zero the shared controller is aborted so the
   * underlying `fn()` can stop. Other callers continue to await the same
   * entry and receive the result when it arrives.
   */
  private _waitWithRefCount<T>(
    entry: InFlightEntry<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (!callerSignal) return entry.promise;

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const release = () => {
        if (entry.refCount > 0) entry.refCount--;
        if (entry.refCount <= 0 && !entry.sharedController.signal.aborted) {
          // Grace period: delay abort so a StrictMode remount can join
          // the in-flight entry before the shared execution is cancelled.
          entry.abortTimer = setTimeout(() => {
            if (entry.refCount <= 0 && !entry.sharedController.signal.aborted) {
              entry.sharedController.abort(
                callerSignal.reason ?? "all cache callers aborted",
              );
            }
          }, CacheManager.ABORT_GRACE_PERIOD_MS);
        }
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        callerSignal.removeEventListener("abort", onAbort);
        release();
        reject(createAbortError(callerSignal));
      };

      if (callerSignal.aborted) {
        onAbort();
        return;
      }

      callerSignal.addEventListener("abort", onAbort, { once: true });

      entry.promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          callerSignal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          callerSignal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
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

    const entry = await this.getValid<T>(key);
    return entry?.value ?? null;
  }

  /**
   * Get a cached entry only if it has not expired.
   * Returns null on miss or expired (and deletes the expired entry).
   *
   * Storage implementations return entries unconditionally — expiry handling
   * lives at the CacheManager layer.
   */
  private async getValid<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = await this.storage.get<T>(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      await this.storage.delete(key);
      return null;
    }
    return entry;
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
    for (const entry of this.inFlightRequests.values()) {
      if (entry.abortTimer) clearTimeout(entry.abortTimer);
    }
    this.inFlightRequests.clear();
  }

  /**
   * Check if a value exists in the cache
   * @param key - Cache key
   * @returns Promise of true if the value exists, false otherwise
   */
  async has(key: string): Promise<boolean> {
    if (!this.config.enabled) return false;

    const entry = await this.getValid(key);
    return entry !== null;
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
