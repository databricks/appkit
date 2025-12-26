import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Cache types
 * @property hash - the hash of the SQL query
 * @property type - the type of the query
 */
interface CacheEntry {
  hash: string;
  type: string;
}

/**
 * Cache interface
 * @property version - the version of the cache
 * @property queries - the queries in the cache
 */
interface Cache {
  version: string;
  queries: Record<string, CacheEntry>;
}

export const CACHE_VERSION = "1";
const CACHE_FILE = ".appkit-types-cache.json";
const CACHE_DIR = path.join(
  process.cwd(),
  "node_modules",
  ".databricks",
  "appkit",
);

/**
 * Hash the SQL query
 * Uses MD5 to hash the SQL query
 * @param sql - the SQL query to hash
 * @returns - the hash of the SQL query
 */
export function hashSQL(sql: string): string {
  return crypto.createHash("md5").update(sql).digest("hex");
}

/**
 * Load the cache from the file system
 * If the cache is not found, run the query explain
 * @returns - the cache
 */
export function loadCache(): Cache {
  const cachePath = path.join(CACHE_DIR, CACHE_FILE);
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Cache;
      if (cache.version === CACHE_VERSION) {
        return cache;
      }
    }
  } catch {
    // ignore cache errors
  }
  return { version: CACHE_VERSION, queries: {} };
}

/**
 * Save the cache to the file system
 * The cache is saved as a JSON file, it is used to avoid running the query explain multiple times
 * @param cache - cache object to save
 */
export function saveCache(cache: Cache): void {
  const cachePath = path.join(CACHE_DIR, CACHE_FILE);
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
}
