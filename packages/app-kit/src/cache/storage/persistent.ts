import { createHash } from "node:crypto";
import type { CacheConfig } from "shared";
import type { LakebaseConnector } from "../../connectors";
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
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly evictionBatchSize: number;
  private initialized: boolean;

  constructor(config: CacheConfig, connector: LakebaseConnector) {
    this.connector = connector;
    this.maxBytes = config.maxBytes ?? lakebaseStorageDefaults.maxBytes;
    this.maxEntryBytes =
      config.maxEntryBytes ?? lakebaseStorageDefaults.maxEntryBytes;
    this.evictionBatchSize = lakebaseStorageDefaults.evictionBatchSize;
    this.tableName = lakebaseStorageDefaults.tableName; // hardcoded, safe for now
    this.initialized = false;
  }

  /** Initialize the persistent storage and run migrations if necessary */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.runMigrations();
      this.initialized = true;
    } catch (error) {
      console.error("Error in persistent storage initialization:", error);
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

    const keyHash = this.hashKey(key);

    const result = await this.connector.query<{
      value: Buffer;
      expiry: string;
    }>(`SELECT value, expiry FROM ${this.tableName} WHERE key_hash = $1`, [
      keyHash,
    ]);

    if (result.rows.length === 0) return null;

    const entry = result.rows[0];

    // fire-and-forget update
    this.connector
      .query(
        `UPDATE ${this.tableName} SET last_accessed = NOW() WHERE key_hash = $1`,
        [keyHash],
      )
      .catch(() => {
        console.debug("Error updating last_accessed time for key:", key);
      });

    return {
      value: this.deserializeValue<T>(entry.value),
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

    const keyHash = this.hashKey(key);
    const keyBytes = Buffer.from(key, "utf-8");
    const valueBytes = this.serializeValue(entry.value);
    const byteSize = keyBytes.length + valueBytes.length;

    if (byteSize > this.maxEntryBytes) {
      throw new Error(
        `Cache entry too large: ${byteSize} bytes exceeds maximum of ${this.maxEntryBytes} bytes`,
      );
    }

    const totalBytes = await this.totalBytes();
    if (totalBytes + byteSize > this.maxBytes) {
      await this.evictBySize(byteSize);
    }

    await this.connector.query(
      `INSERT INTO ${this.tableName} (key_hash, key, value, byte_size, expiry, created_at, last_accessed)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (key_hash)
      DO UPDATE SET value = $3, byte_size = $4, expiry = $5, last_accessed = NOW()
      `,
      [keyHash, keyBytes, valueBytes, byteSize, entry.expiry],
    );
  }

  /**
   * Delete a value from the persistent storage
   * @param key - Cache key
   * @returns Promise of the result
   */
  async delete(key: string): Promise<void> {
    await this.ensureInitialized();
    const keyHash = this.hashKey(key);
    await this.connector.query(
      `DELETE FROM ${this.tableName} WHERE key_hash = $1`,
      [keyHash],
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
    const keyHash = this.hashKey(key);

    const result = await this.connector.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ${this.tableName} WHERE key_hash = $1) as exists`,
      [keyHash],
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

  /** Get the total number of bytes in the persistent storage */
  async totalBytes(): Promise<number> {
    await this.ensureInitialized();

    const result = await this.connector.query<{ total: string }>(
      `SELECT COALESCE(SUM(byte_size), 0) as total FROM ${this.tableName}`,
    );
    return parseInt(result.rows[0]?.total ?? "0", 10);
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

  /** Evict entries from the persistent storage by size */
  private async evictBySize(requiredBytes: number): Promise<void> {
    const freedByExpiry = await this.cleanupExpired();
    if (freedByExpiry > 0) {
      const currentBytes = await this.totalBytes();
      if (currentBytes + requiredBytes <= this.maxBytes) {
        return;
      }
    }

    await this.connector.query(
      `DELETE FROM ${this.tableName} WHERE key_hash IN
      (SELECT key_hash FROM ${this.tableName} ORDER BY last_accessed ASC LIMIT $1)`,
      [this.evictionBatchSize],
    );
  }

  /** Ensure the persistent storage is initialized */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /** Generate a 64-bit hash for the cache key using SHA256 */
  private hashKey(key: string): bigint {
    if (!key) throw new Error("Cache key cannot be empty");
    const hash = createHash("sha256").update(key).digest();
    return hash.readBigInt64BE(0);
  }

  /** Serialize a value to a buffer */
  private serializeValue<T>(value: T): Buffer {
    return Buffer.from(JSON.stringify(value), "utf-8");
  }

  /** Deserialize a value from a buffer */
  private deserializeValue<T>(buffer: Buffer): T {
    return JSON.parse(buffer.toString("utf-8")) as T;
  }

  /** Run migrations for the persistent storage */
  private async runMigrations(): Promise<void> {
    try {
      await this.connector.query(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                id BIGSERIAL PRIMARY KEY,
                key_hash BIGINT NOT NULL,
                key BYTEA NOT NULL,
                value BYTEA NOT NULL,
                byte_size INTEGER NOT NULL,
                expiry BIGINT NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                last_accessed TIMESTAMP NOT NULL DEFAULT NOW()
            )
            `);

      // unique index on key_hash for fast lookups
      await this.connector.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.tableName}_key_hash ON ${this.tableName} (key_hash);`,
      );

      // index on expiry for cleanup queries
      await this.connector.query(
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expiry ON ${this.tableName} (expiry); `,
      );

      // index on last_accessed for LRU eviction
      await this.connector.query(
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_last_accessed ON ${this.tableName} (last_accessed); `,
      );

      // index on byte_size for monitoring
      await this.connector.query(
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_byte_size ON ${this.tableName} (byte_size); `,
      );
    } catch (error) {
      console.error(
        "Error in running migrations for persistent storage:",
        error,
      );
      throw error;
    }
  }
}
