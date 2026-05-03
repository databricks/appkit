import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Incremented when the generator's output shape changes in a way that would
 * invalidate previously-cached `.d.ts` files. Bump and the next run ignores
 * stale caches and re-emits.
 */
export const CACHE_VERSION = 1;

/** A single cached generation result — tied to the hash of `schema.ts` source. */
export interface DatabaseCacheEntry {
  /** sha256 of the `schema.ts` source string. */
  hash: string;
  /** Generated `.d.ts` output last produced from this hash. */
  output: string;
}

/** Root shape persisted under `node_modules/.databricks/appkit/database/cache.json`. */
export interface DatabaseCache {
  version: number;
  entry?: DatabaseCacheEntry;
}

const CACHE_RELATIVE = "node_modules/.databricks/appkit/database/cache.json";

/** Stable sha256 hash of a `schema.ts` source string. */
export function hashSchemaSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

/**
 * Load the on-disk cache for the given project root. Missing or malformed
 * caches return a fresh empty state; they never throw.
 */
export async function loadDatabaseCache(
  projectRoot: string,
): Promise<DatabaseCache> {
  try {
    const raw = await fs.readFile(
      path.join(projectRoot, CACHE_RELATIVE),
      "utf8",
    );
    const parsed = JSON.parse(raw) as DatabaseCache;
    if (parsed.version !== CACHE_VERSION) return { version: CACHE_VERSION };
    return parsed;
  } catch {
    return { version: CACHE_VERSION };
  }
}

/** Persist the cache under `node_modules/.databricks/appkit/database/cache.json`. */
export async function saveDatabaseCache(
  projectRoot: string,
  cache: DatabaseCache,
): Promise<void> {
  const target = path.join(projectRoot, CACHE_RELATIVE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(cache, null, 2), "utf8");
}
