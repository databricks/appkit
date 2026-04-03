import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../logging/logger";

const logger = createLogger("type-generator:serving:cache");

export const CACHE_VERSION = "1";
const CACHE_FILE = ".appkit-serving-types-cache.json";
const CACHE_DIR = path.join(
  process.cwd(),
  "node_modules",
  ".databricks",
  "appkit",
);

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

export function hashSchema(schemaJson: string): string {
  return crypto.createHash("sha256").update(schemaJson).digest("hex");
}

export async function loadServingCache(): Promise<ServingCache> {
  const cachePath = path.join(CACHE_DIR, CACHE_FILE);
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
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
  const cachePath = path.join(CACHE_DIR, CACHE_FILE);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
}
