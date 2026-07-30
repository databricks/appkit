import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createLogger } from "../logging/logger";
import {
  deindentBlock,
  parseCacheHeader,
  splitEntryBlocks,
} from "./embedded-cache";

const logger = createLogger("type-generator:cache");

/**
 * Cache entry for a single query.
 * @property hash - the hash of the SQL query
 * @property type - the rendered TypeScript type for the query
 * @property retry - when true the entry never satisfies a cache hit, so the
 *   query is re-described on the next pass; fresh successful describes
 *   persist `retry: false`
 */
export interface CacheEntry {
  hash: string;
  type: string;
  retry: boolean;
}

/**
 * In-memory query cache, reconstructed from a committed generated `analytics.d.ts`.
 *
 * The generated file carries one hash per entry in its header comment and the
 * rendered type block in its body; {@link loadQueryCache} pairs the two back
 * into this shape, which the query hit/degrade logic consumes.
 */
export interface Cache {
  version: string;
  queries: Record<string, CacheEntry>;
}

export const CACHE_VERSION = "3";

/** Registry interface name whose members hold the query type blocks. */
const QUERY_INTERFACE = "QueryRegistry";

/**
 * Indentation (in spaces) that {@link generateTypeDeclarations} applies to
 * every non-first line of a query type block at assembly time. Reversed here so
 * a block extracted from a committed file re-renders byte-identically.
 */
const QUERY_BLOCK_INDENT = 4;

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
 * Change detector for a metric-view entry: md5 over `"<source>|<lane>"` — the
 * two config inputs that determine a DESCRIBE — so editing either invalidates
 * the entry.
 */
export function metricCacheHash(source: string, lane: string): string {
  return hashSQL(`${source}|${lane}`);
}

/**
 * Reconstruct the query cache from a committed `analytics.d.ts`.
 *
 * Reads the header hash table and pairs each entry with its rendered type block
 * from the file body. A missing file, missing header, or a version mismatch all
 * yield an empty cache (every query reads as a MISS and is re-described).
 */
export async function loadQueryCache(outFile: string): Promise<Cache> {
  let source: string;
  try {
    source = await fs.readFile(outFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        "Could not read generated types at %s, treating as empty cache.",
        outFile,
      );
    }
    return { version: CACHE_VERSION, queries: {} };
  }

  const header = parseCacheHeader(source);
  if (header.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, queries: {} };
  }

  const blocks = splitEntryBlocks(source, QUERY_INTERFACE);
  const queries: Record<string, CacheEntry> = Object.create(null);
  for (const [name, hash] of Object.entries(header.hashes)) {
    const block = blocks[name];
    if (block === undefined) continue; // header/body drift → miss
    queries[name] = {
      hash,
      type: deindentBlock(block, QUERY_BLOCK_INDENT),
      retry: false,
    };
  }

  return { version: CACHE_VERSION, queries };
}

/** Registry interface name whose members hold the metric type blocks. */
const METRIC_INTERFACE = "MetricRegistry";

/**
 * One reconstructed metric cache entry.
 * @property hash - md5 of `"<source>|<lane>"` at generation time
 * @property member - the full rendered member string (`    "key": { ... }`) as
 *   produced by the metric renderer, reused verbatim on a cache hit
 */
export interface MetricCacheEntry {
  hash: string;
  member: string;
}

interface MetricCache {
  version: string;
  entries: Record<string, MetricCacheEntry>;
}

/**
 * Reconstruct the metric-view cache from a committed `metric-views.d.ts`.
 *
 * The value block extracted from the file body is exactly what the metric
 * renderer emits for a metric's value, so the full member is reassembled as
 * `    "<key>": <valueBlock>` — reusable verbatim without reconstructing the
 * underlying `MetricSchema`. Missing file / header / version mismatch → empty.
 */
export async function loadMetricCache(mvOutFile: string): Promise<MetricCache> {
  let source: string;
  try {
    source = await fs.readFile(mvOutFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        "Could not read generated metric types at %s, treating as empty cache.",
        mvOutFile,
      );
    }
    return { version: CACHE_VERSION, entries: {} };
  }

  const header = parseCacheHeader(source);
  if (header.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, entries: {} };
  }

  const blocks = splitEntryBlocks(source, METRIC_INTERFACE);
  const entries: Record<string, MetricCacheEntry> = Object.create(null);
  for (const [key, hash] of Object.entries(header.hashes)) {
    const block = blocks[key];
    if (block === undefined) continue; // header/body drift → miss
    entries[key] = { hash, member: `    ${JSON.stringify(key)}: ${block}` };
  }

  return { version: CACHE_VERSION, entries };
}
