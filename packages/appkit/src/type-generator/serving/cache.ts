import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getCommittedCacheDir } from "shared";
import { createLogger } from "../../logging/logger";

const logger = createLogger("type-generator:serving:cache");

export const CACHE_VERSION = "1";
const CACHE_FILE = "serving-types-cache.json";

export interface ServingCacheEntry {
  hash: string;
  requestType: string;
  responseType: string;
  chunkType: string | null;
  requestKeys: string[];
}

export interface ServingCache {
  version: string;
  endpoints: Record<string, ServingCacheEntry>;
}

/**
 * Absolute path of the committed serving-types cache. The single source of
 * truth shared by the writer (this module) and the runtime reader
 * (serving plugin `setup()`), so a relocation can never desync them.
 */
export function getServingCachePath(): string {
  return path.join(getCommittedCacheDir(), CACHE_FILE);
}

export function hashSchema(schemaJson: string): string {
  return crypto.createHash("sha256").update(schemaJson).digest("hex");
}

export async function loadServingCache(): Promise<ServingCache> {
  const cachePath = getServingCachePath();
  const cacheDir = getCommittedCacheDir();
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const raw = await fs.readFile(cachePath, "utf8");
    const cache = JSON.parse(raw) as ServingCache;
    if (cache.version === CACHE_VERSION) {
      return cache;
    }
    logger.debug("Cache version mismatch, starting fresh");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("Cache file is corrupted, flushing cache completely.");
    }
  }
  return { version: CACHE_VERSION, endpoints: {} };
}

export async function saveServingCache(cache: ServingCache): Promise<void> {
  const cachePath = getServingCachePath();
  const cacheDir = getCommittedCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });

  // Sort endpoint keys for deterministic output (merge-friendly diffs)
  const sortedCache: ServingCache = {
    version: cache.version,
    endpoints: Object.keys(cache.endpoints)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = cache.endpoints[key];
          return acc;
        },
        {} as Record<string, (typeof cache.endpoints)[string]>,
      ),
  };

  await fs.writeFile(cachePath, JSON.stringify(sortedCache, null, 2), "utf8");
}
