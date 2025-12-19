/** Default configuration for in-memory storage */
export const inMemoryStorageDefaults = {
  /** Maximum number of entries in the cache */
  maxSize: 1000,
};

/** Default configuration for Lakebase storage */
export const lakebaseStorageDefaults = {
  /** Table name for the cache */
  tableName: "appkit_cache_entries",
  /** Maximum number of bytes in the cache */
  maxBytes: 256 * 1024 * 1024, // 256MB
  /** Maximum number of bytes per entry in the cache */
  maxEntryBytes: 10 * 1024 * 1024, // 10MB
  /** Maximum number of entries in the cache */
  maxSize: 1000,
  /** Number of entries to evict when cache is full */
  evictionBatchSize: 100,
  /** Probability (0-1) of checking total bytes on each write operation */
  evictionCheckProbability: 0.1,
};
