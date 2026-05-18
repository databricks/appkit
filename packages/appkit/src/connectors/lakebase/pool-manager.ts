import type { LakebasePoolConfig } from "@databricks/lakebase";
import type { Pool } from "pg";
import { createLakebasePool } from "./index";

/** Interval for removing empty (connectionless) pools from the Map. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Manages multiple Lakebase connection pools keyed by an identifier (e.g. userId).
 *
 * Used for On-Behalf-Of (OBO) scenarios where each user needs their own pool
 * with their own OAuth token refresh, enabling features like Row-Level Security.
 */
export interface LakebasePoolManager {
  /**
   * Get an existing pool or create a new one for the given key.
   * When creating, merges `perPoolConfig` with the base config passed to the factory.
   *
   * If `tokenFingerprint` is provided and differs from the cached pool's
   * fingerprint, the stale pool is closed and a fresh one is created with
   * the new config (including the updated `workspaceClient`).
   */
  getPool(
    key: string,
    perPoolConfig: Partial<LakebasePoolConfig>,
    tokenFingerprint?: string,
  ): Pool;

  /** Check whether a pool exists for the given key. */
  hasPool(key: string): boolean;

  /** Close and remove a specific pool. */
  closePool(key: string): Promise<void>;

  /** Close all managed pools and stop cleanup (for graceful shutdown). */
  closeAll(): Promise<void>;

  /** Number of active pools. */
  readonly size: number;
}

/**
 * Create a pool manager that maintains per-key Lakebase connection pools.
 *
 * Each pool is created via `createLakebasePool` with the base config merged
 * with per-pool overrides (e.g. a user's `workspaceClient` and `user`).
 *
 * A periodic cleanup removes empty Pool objects (where all connections have
 * been closed by pg's built-in `idleTimeoutMillis`) from the internal Map.
 *
 * @example OBO usage
 * ```typescript
 * const poolManager = createLakebasePoolManager();
 *
 * // In a route handler:
 * const userPool = poolManager.getPool(userName, {
 *   workspaceClient: new WorkspaceClient({ token: userToken, host, authType: "pat" }),
 *   user: userName,
 * });
 * const result = await userPool.query("SELECT * FROM products");
 * ```
 */
export function createLakebasePoolManager(
  baseConfig?: Partial<LakebasePoolConfig>,
): LakebasePoolManager {
  interface PoolEntry {
    pool: Pool;
    tokenFingerprint?: string;
  }

  const entries = new Map<string, PoolEntry>();

  // Periodically remove empty Pool objects from the Map.
  // pg.Pool's idleTimeoutMillis closes idle connections automatically;
  // this just cleans up the Map entries once all connections are gone.
  const cleanupTimer = setInterval(() => {
    for (const [key, entry] of entries) {
      if (entry.pool.totalCount === 0) {
        entry.pool.end().catch(() => {});
        entries.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  return {
    getPool(
      key: string,
      perPoolConfig: Partial<LakebasePoolConfig>,
      tokenFingerprint?: string,
    ): Pool {
      const existing = entries.get(key);

      if (existing) {
        // When the caller provides a fingerprint that differs from the
        // cached one, the underlying OBO token has rotated. The pool's
        // password callback holds a stale WorkspaceClient (authType: "pat",
        // static token) that will fail once the Lakebase Postgres token
        // needs refreshing. Drain the old pool and create a fresh one.
        const stale =
          tokenFingerprint &&
          existing.tokenFingerprint &&
          tokenFingerprint !== existing.tokenFingerprint;

        if (!stale) return existing.pool;

        existing.pool.end().catch(() => {});
      }

      // Safe without locking: createLakebasePool is synchronous and Node.js
      // is single-threaded, so no preemption between get() and set().
      const pool = createLakebasePool({ ...baseConfig, ...perPoolConfig });
      entries.set(key, { pool, tokenFingerprint });
      return pool;
    },

    hasPool(key: string): boolean {
      return entries.has(key);
    },

    async closePool(key: string): Promise<void> {
      const entry = entries.get(key);
      if (entry) {
        await entry.pool.end();
        entries.delete(key);
      }
    },

    async closeAll(): Promise<void> {
      clearInterval(cleanupTimer);
      const endPromises = [...entries.values()].map((e) => e.pool.end());
      await Promise.all(endPromises);
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
