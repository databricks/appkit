/** Default configuration for in-memory storage */
export const inMemoryStorageDefaults = {
  /** Maximum number of entries in the cache */
  maxSize: 1000,
};

/** Default configuration for Lakebase storage */
export const lakebaseStorageDefaults = {
  /** Table name for the cache */
  tableName: "appkit_cache_entries",
  /** Maximum number of entries in the cache */
  maxSize: 5000,
  /** Number of entries to evict when cache is full */
  evictionBatchSize: 100,
};
