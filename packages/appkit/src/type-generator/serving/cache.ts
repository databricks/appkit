import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createLogger } from "../../logging/logger";
import { parseCacheHeader, splitEntryBlocks } from "../embedded-cache";

const logger = createLogger("type-generator:serving:cache");

export const CACHE_VERSION = "1";

/** Registry interface name whose members hold the serving type blocks. */
const SERVING_INTERFACE = "ServingEndpointRegistry";

export interface ServingCacheEntry {
  /**
   * Local identity hash: sha256 of `"<alias>|<resolvedEndpointName>"`. It is
   * computable WITHOUT fetching the OpenAPI schema, so a matching committed
   * entry lets a build/deploy skip the network fetch entirely. Upstream schema
   * drift (same endpoint, changed model) is not detected — use `--no-cache` to
   * force a refresh.
   */
  hash: string;
  /** Rendered registry member body (`{ request: ...; response: ...; chunk: ...; }`). */
  member: string;
}

export interface ServingCache {
  version: string;
  endpoints: Record<string, ServingCacheEntry>;
}

/**
 * Local identity hash for a serving endpoint. Computed from the alias and the
 * resolved endpoint name (from the config's env var) — both known locally, so
 * a cache hit needs no `getOpenApi` call.
 */
export function endpointIdentityHash(
  alias: string,
  endpointName: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`${alias}|${endpointName}`)
    .digest("hex");
}

/**
 * Reconstruct the serving cache from a committed `serving.d.ts`.
 *
 * Reads the header hash table and pairs each alias with its rendered member
 * body from the file (both `declare module` blocks are identical, so the first
 * found suffices). Missing file / header / version mismatch → empty cache.
 */
export async function loadServingCache(outFile: string): Promise<ServingCache> {
  let source: string;
  try {
    source = await fs.readFile(outFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        "Could not read generated serving types at %s, treating as empty cache.",
        outFile,
      );
    }
    return { version: CACHE_VERSION, endpoints: {} };
  }

  const header = parseCacheHeader(source);
  if (header.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, endpoints: {} };
  }

  const blocks = splitEntryBlocks(source, SERVING_INTERFACE);
  const endpoints: Record<string, ServingCacheEntry> = {};
  for (const [alias, hash] of Object.entries(header.hashes)) {
    const block = blocks[alias];
    if (block === undefined) continue; // header/body drift → miss
    endpoints[alias] = { hash, member: block };
  }

  return { version: CACHE_VERSION, endpoints };
}
