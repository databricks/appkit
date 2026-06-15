import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../logging/logger";
import type { MetricSchema } from "./metric-registry";

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
 * One cached metric-view DESCRIBE outcome.
 *
 * `hash` is md5 over `"<source>|<lane>"` — the two config inputs that
 * determine a DESCRIBE — so editing either invalidates the entry. `schema`
 * is the full {@link MetricSchema} persisted verbatim (it is JSON-safe by
 * design), letting a warm pass regenerate both metric artifacts without a
 * single warehouse call. `retry: true` marks a SELF-CONVERGING degraded
 * outcome (DESCRIBE skipped behind a not-running warehouse, unanswered, or
 * transiently failed): the cached schema still renders artifacts, but the
 * next eligible pass re-describes exactly these keys so degraded schemas
 * converge to real ones. A degraded schema with `retry: false` is a STICKY
 * failure — a deterministic DESCRIBE failure (bad FQN, unparseable
 * response, zero columns) or a deleted warehouse — that re-describing the
 * unchanged entry cannot fix; it hits like any cached entry until the
 * config hash changes or the cache is bypassed, and the type generator
 * warns about it on every pass that serves it.
 */
export interface MetricCacheEntry {
  hash: string;
  schema: MetricSchema;
  retry: boolean;
}

/**
 * Cache interface
 * @property version - the version of the cache
 * @property queries - the queries in the cache
 * @property metrics - cached metric-view schemas keyed by metric key.
 *   OPTIONAL on purpose: version "3" files written before this section
 *   existed load unchanged (absent ⇒ treated as empty by the metric path),
 *   and the query path's `noCache` reinit literal stays valid as-is. The
 *   section rides through the query path's load → mutate → save cycle as a
 *   plain sibling key, so query-side saves preserve it byte-for-byte.
 */
interface Cache {
  version: string;
  queries: Record<string, CacheEntry>;
  metrics?: Record<string, MetricCacheEntry>;
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
