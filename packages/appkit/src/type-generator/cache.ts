import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../logging/logger";

const logger = createLogger("type-generator:cache");

/**
 * Cache types
 * @property hash - the hash of the SQL query
 * @property type - the type of the query
 */
interface CacheEntry {
  hash: string;
  type: string;
  retry: boolean;
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

export const CACHE_VERSION = "3";
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
export async function loadCache(): Promise<Cache> {
  const cachePath = path.join(CACHE_DIR, CACHE_FILE);
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });

    const raw = await fs.readFile(cachePath, "utf8");
    const cache = JSON.parse(raw) as Cache;
    if (cache.version === CACHE_VERSION) {
      return cache;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("Cache file is corrupted, flushing cache completely.");
    }
  }
  return { version: CACHE_VERSION, queries: {} };
}

/**
 * Save the cache to the file system
 * @param cache - cache object to save
 */
export async function saveCache(cache: Cache): Promise<void> {
  const cachePath = path.join(CACHE_DIR, CACHE_FILE);
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
}
