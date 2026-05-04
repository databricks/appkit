import type { LakebasePoolConfig } from "@databricks/lakebase";
import type { Pool } from "pg";
import { createLakebasePool } from "./index";

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
   * On subsequent calls with the same key, `perPoolConfig` is ignored and the cached pool is returned.
   */
  getPool(key: string, perPoolConfig: Partial<LakebasePoolConfig>): Pool;

  /** Check whether a pool exists for the given key. */
  hasPool(key: string): boolean;

  /** Close and remove a specific pool. */
  closePool(key: string): Promise<void>;

  /** Close all managed pools (for graceful shutdown). */
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
  const pools = new Map<string, Pool>();

  return {
    getPool(key: string, perPoolConfig: Partial<LakebasePoolConfig>): Pool {
      const existing = pools.get(key);
      if (existing) return existing;

      const pool = createLakebasePool({ ...baseConfig, ...perPoolConfig });
      pools.set(key, pool);
      return pool;
    },

    hasPool(key: string): boolean {
      return pools.has(key);
    },

    async closePool(key: string): Promise<void> {
      const pool = pools.get(key);
      if (pool) {
        await pool.end();
        pools.delete(key);
      }
    },

    async closeAll(): Promise<void> {
      const endPromises = [...pools.values()].map((p) => p.end());
      await Promise.all(endPromises);
      pools.clear();
    },

    get size() {
      return pools.size;
    },
  };
}
