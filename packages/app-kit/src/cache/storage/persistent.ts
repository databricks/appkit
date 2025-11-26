import type { LakebaseConnector } from "../../connectors";
import type { CacheConfig } from "shared";
import { lakebaseStorageDefaults } from "./defaults";
import type { CacheEntry, CacheStorage } from "./types";

/**
 * Persistent cache storage implementation. Uses a least recently used (LRU) eviction policy
 * to manage memory usage and ensure efficient cache operations.
 *
 * @example
 * const persistentStorage = new PersistentStorage(config, connector);
 * await persistentStorage.initialize();
 * await persistentStorage.get("my-key");
 * await persistentStorage.set("my-key", "my-value");
 * await persistentStorage.delete("my-key");
 * await persistentStorage.clear();
 * await persistentStorage.has("my-key");
 *
 */
export class PersistentStorage implements CacheStorage {
  private readonly connector: LakebaseConnector;
  private readonly tableName: string;
  private readonly maxSize: number;
  private readonly evictionBatchSize: number;
  private initialized: boolean;

  constructor(config: CacheConfig, connector: LakebaseConnector) {
    this.connector = connector;
    this.maxSize = config.maxSize ?? lakebaseStorageDefaults.maxSize;
    this.evictionBatchSize = lakebaseStorageDefaults.evictionBatchSize;
    this.tableName = lakebaseStorageDefaults.tableName;
    this.initialized = false;
  }

  /** Initialize the persistent storage and run migrations if necessary */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.runMigrations();
      this.initialized = true;
    } catch (error) {
      console.error("Error in for persistent storage initialization:", error);
      throw error;
    }
  }

  /**
   * Get a cached value from the persistent storage
   * @param key - Cache key
   * @returns Promise of the cached value or null if not found
   */
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    await this.ensureInitialized();

    const result = await this.connector.query<{ value: T; expiry: string }>(
      `SELECT value, expiry FROM ${this.tableName} WHERE cache_key = $1`,
      [key],
    );

    if (result.rows.length === 0) return null;

    const entry = result.rows[0];

    // fire-and-forget update
    this.connector
      .query(
        `UPDATE ${this.tableName} SET last_accessed = $1 WHERE cache_key = $2`,
        [Date.now(), key],
      )
      .catch(() => {
        console.debug("Error updating last_accessed time for key:", key);
      });

    return {
      value: entry.value as T,
      expiry: Number(entry.expiry),
    };
  }

  /**
   * Set a value in the persistent storage
   * @param key - Cache key
   * @param entry - Cache entry
   * @returns Promise of the result
   */
  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    await this.ensureInitialized();

    const exists = await this.has(key);
    if (!exists) {
      const currentSize = await this.size();
      if (currentSize >= this.maxSize) {
        await this.evictLRU();
      }
    }

    await this.connector.query(
      `INSERT INTO ${this.tableName} (cache_key, value, expiry, last_accessed)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (cache_key)
      DO UPDATE SET value = $2, expiry = $3, last_accessed = $4
      `,
      [key, JSON.stringify(entry.value), entry.expiry, Date.now()],
    );
  }

  /**
   * Delete a value from the persistent storage
   * @param key - Cache key
   * @returns Promise of the result
   */
  async delete(key: string): Promise<void> {
    await this.ensureInitialized();
    await this.connector.query(
      `DELETE FROM ${this.tableName} WHERE cache_key = $1`,
      [key],
    );
  }

  /** Clear the persistent storage */
  async clear(): Promise<void> {
    await this.ensureInitialized();
    await this.connector.query(`TRUNCATE TABLE ${this.tableName}`);
  }

  /**
   * Check if a value exists in the persistent storage
   * @param key - Cache key
   * @returns Promise of true if the value exists, false otherwise
   */
  async has(key: string): Promise<boolean> {
    await this.ensureInitialized();

    const result = await this.connector.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ${this.tableName} WHERE cache_key = $1) as exists`,
      [key],
    );

    return result.rows[0]?.exists ?? false;
  }

  /**
   * Get the size of the persistent storage
   * @returns Promise of the size of the storage
   */
  async size(): Promise<number> {
    await this.ensureInitialized();

    const result = await this.connector.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${this.tableName}`,
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  /**
   * Check if the persistent storage is persistent
   * @returns true if the storage is persistent, false otherwise
   */
  isPersistent(): boolean {
    return true;
  }

  /**
   * Check if the persistent storage is healthy
   * @returns Promise of true if the storage is healthy, false otherwise
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await this.connector.healthCheck();
    } catch {
      return false;
    }
  }

  /** Close the persistent storage */
  async close(): Promise<void> {
    await this.connector.close();
  }

  /**
   * Cleanup expired entries from the persistent storage
   * @returns Promise of the number of expired entries
   */
  async cleanupExpired(): Promise<number> {
    await this.ensureInitialized();
    const result = await this.connector.query<{ count: string }>(
      `WITH deleted as (DELETE FROM ${this.tableName} WHERE expiry < $1 RETURNING *) SELECT COUNT(*) as count FROM deleted`,
      [Date.now()],
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  /** Evict the least recently used entries from the persistent storage (batched) */
  private async evictLRU(): Promise<void> {
    await this.connector.query(
      `DELETE FROM ${this.tableName} WHERE cache_key IN (
        SELECT cache_key FROM ${this.tableName} ORDER BY last_accessed ASC LIMIT $1
      )`,
      [this.evictionBatchSize],
    );
  }

  /** Ensure the persistent storage is initialized */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /** Run migrations for the persistent storage */
  private async runMigrations(): Promise<void> {
    try {
      await this.connector.query(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                cache_key VARCHAR(255) PRIMARY KEY,
                value JSONB NOT NULL,
                expiry BIGINT NOT NULL,
                last_accessed BIGINT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            `);

      await this.connector.query(`
                CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expiry ON ${this.tableName} (expiry);
            `);
      await this.connector.query(`
                CREATE INDEX IF NOT EXISTS idx_${this.tableName}_last_accessed ON ${this.tableName} (last_accessed);
            `);
    } catch (error) {
      console.error(
        "Error in running migrations for persistent storage:",
        error,
      );
      throw error;
    }
  }
}
