import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Incremented when the generator's output shape changes in a way that would
 * invalidate previously-cached `.d.ts` files. Bump and the next run ignores
 * stale caches and re-emits.
 *
 * v2: hash now folds in transitively-imported relative modules too, so
 * splitting `schema.ts` into `./tables/*.ts` no longer hides edits from the
 * cache.
 */
export const CACHE_VERSION = 2;

/** A single cached generation result. */
export interface DatabaseCacheEntry {
  /** sha256 of the schema graph. */
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

/** Stable sha256 hash of a single source string. */
export function hashSchemaSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

/**
 * Hash the schema and every relative module it imports, recursively. F41:
 * caching only `schema.ts` missed edits to `./tables/*.ts` helpers, so the
 * generator returned stale `.d.ts` output until the cache was manually busted.
 *
 * Implementation is intentionally lightweight (regex over import specifiers)
 * rather than a full TS parser: we only care about specifiers, which appear
 * on one line and do not require type-aware resolution. Non-relative
 * specifiers (npm packages) are ignored.
 */
export async function hashSchemaSourceWithDeps(
  schemaPath: string,
): Promise<string> {
  const visited = new Map<string, string>();
  await collectSource(path.resolve(schemaPath), visited);
  const combined = Array.from(visited.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, source]) => file + " " + source)
    .join("");
  return createHash("sha256").update(combined).digest("hex");
}

const RELATIVE_IMPORT = /(?:from|import)\s+["']((?:\.\.?\/)[^"']+)["']/g;
const SOURCE_EXT = [".ts", ".tsx", ".js", ".mjs"];

async function collectSource(
  filePath: string,
  visited: Map<string, string>,
): Promise<void> {
  if (visited.has(filePath)) return;
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  visited.set(filePath, source);

  const dir = path.dirname(filePath);
  RELATIVE_IMPORT.lastIndex = 0;
  let match: RegExpExecArray | null = RELATIVE_IMPORT.exec(source);
  while (match !== null) {
    const resolved = await resolveRelative(dir, match[1]);
    if (resolved) await collectSource(resolved, visited);
    match = RELATIVE_IMPORT.exec(source);
  }
}

async function resolveRelative(
  fromDir: string,
  specifier: string,
): Promise<string | null> {
  const base = path.resolve(fromDir, specifier);
  const candidates = [
    base,
    ...SOURCE_EXT.map((ext) => base + ext),
    ...SOURCE_EXT.map((ext) => path.join(base, "index" + ext)),
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
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
