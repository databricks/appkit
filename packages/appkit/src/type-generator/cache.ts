import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../logging/logger";
import type { MetricSchema } from "./mv-registry/types";

const logger = createLogger("type-generator:cache");

/**
 * Cache types
 * @property hash - the hash of the SQL query
 * @property type - the type of the query
 * @property retry - when true the entry never satisfies a cache hit, so the
 *   query is re-described on the next pass; fresh successful describes
 *   persist `retry: false`
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
 * design), letting a warm pass regenerate the metric artifact without a
 * single warehouse call.
 */
export interface MetricCacheEntry {
  hash: string;
  schema: MetricSchema;
  retry: boolean;
}

/**
 * Structural gate for reviving a cached metric entry at partition time.
 *
 * The cache file lives in `node_modules/.databricks` and is plain JSON —
 * hand-edits, truncation, or a stale writer can leave entries whose shape no
 * longer matches {@link MetricCacheEntry}. A malformed entry must read as a
 * cache MISS (re-describe) rather than crash the pass or render revived
 * garbage into the artifacts.
 */
export function isRevivableMetricCacheEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.hash !== "string" || typeof e.retry !== "boolean") {
    return false;
  }
  const schema = e.schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return false;
  }
  const s = schema as Record<string, unknown>;
  const isColumnArray = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every(
      (col) =>
        typeof col === "object" &&
        col !== null &&
        typeof (col as Record<string, unknown>).name === "string" &&
        typeof (col as Record<string, unknown>).type === "string",
    );
  return (
    typeof s.key === "string" &&
    typeof s.source === "string" &&
    (s.lane === "sp" || s.lane === "obo") &&
    (s.degraded === undefined || typeof s.degraded === "boolean") &&
    isColumnArray(s.measures) &&
    isColumnArray(s.dimensions)
  );
}

/**
 * Cache interface
 * @property version - the version of the cache
 * @property queries - the queries in the cache
 * @property metrics - cached metric-view schemas keyed by metric key.
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
 * Change detector stored on {@link MetricCacheEntry.hash}: md5 over
 * `"<source>|<lane>"` — the two config inputs that determine a DESCRIBE —
 * so editing either invalidates the entry.
 */
export function metricCacheHash(source: string, lane: string): string {
  return hashSQL(`${source}|${lane}`);
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
