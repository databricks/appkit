/** Cache entry interface */
export interface CacheEntry<T = any> {
  value: T;
  expiry: number;
}

/** Cache storage interface */
export interface CacheStorage {
  /** Get a cached value from the storage */
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  /** Set a value in the storage */
  set<T>(key: string, entry: CacheEntry<T>): Promise<void>;
  /** Delete a value from the storage */
  delete(key: string): Promise<void>;
  /** Clear the storage */
  clear(): Promise<void>;
  /** Check if a value exists in the storage */
  has(key: string): Promise<boolean>;
  /** Get the size of the storage */
  size(): Promise<number>;
  /** Check if the storage is persistent */
  isPersistent(): boolean;
  /** Check if the storage is healthy */
  healthCheck(): Promise<boolean>;
  /** Close the storage */
  close(): Promise<void>;
}
