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
 * Structural gate for reviving a cached metric entry at partition time.
 *
 * The cache file lives in `node_modules/.databricks` and is plain JSON —
 * hand-edits, truncation, or a stale writer can leave entries whose shape no
 * longer matches {@link MetricCacheEntry}. A malformed entry must read as a
 * cache MISS (re-describe) rather than crash the pass or render revived
 * garbage into the artifacts. Checks exactly what the renderers and the
 * metadata bundle consume: `hash` string, `retry` boolean, and a schema with
 * `key`/`source` strings, a valid lane, an optional boolean `degraded`, and
 * measure/dimension arrays whose elements carry `name`/`type` strings
 * (other column fields are optional). Deliberately inline — the shared Zod
 * schemas must not enter the type-generator's runtime path.
 */
export function isRevivableMetricCacheEntry(entry: MetricCacheEntry): boolean {
  if (typeof entry.hash !== "string" || typeof entry.retry !== "boolean") {
    return false;
  }
  const schema = entry.schema as unknown;
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
