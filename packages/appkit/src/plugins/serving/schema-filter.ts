import fs from "node:fs/promises";
import { createLogger } from "../../logging/logger";
import type { ServingCache } from "../../type-generator/serving/cache";

const logger = createLogger("serving:schema-filter");

/**
 * Loads endpoint schemas from the type generation cache file.
 * Returns a map of alias → allowed parameter keys.
 */
export async function loadEndpointSchemas(
  cacheFile: string,
): Promise<Map<string, Set<string>>> {
  const allowlists = new Map<string, Set<string>>();

  try {
    const raw = await fs.readFile(cacheFile, "utf8");
    const cache = JSON.parse(raw) as ServingCache;

    for (const [alias, entry] of Object.entries(cache.endpoints)) {
      // Extract property keys from the requestType string
      // The requestType is a TypeScript object type like "{ messages: ...; temperature: ...; }"
      const keys = extractPropertyKeys(entry.requestType);
      if (keys.size > 0) {
        allowlists.set(alias, keys);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        "Failed to load serving types cache: %s",
        (err as Error).message,
      );
    }
    // No cache → no filtering, passthrough mode
  }

  return allowlists;
}

/**
 * Extracts top-level property keys from a TypeScript object type string.
 * Matches patterns like `key:` or `key?:` at the first nesting level.
 */
function extractPropertyKeys(typeStr: string): Set<string> {
  const keys = new Set<string>();
  // Match property names at the top level of the object type
  // Looking for patterns: `  propertyName:` or `  propertyName?:`
  const propRegex = /^\s{2}(?:\/\*\*[^*]*\*\/\s*)?(\w+)\??:/gm;
  for (
    let match = propRegex.exec(typeStr);
    match !== null;
    match = propRegex.exec(typeStr)
  ) {
    keys.add(match[1]);
  }
  return keys;
}

/**
 * Filters a request body against the allowed keys for an endpoint alias.
 * Returns the filtered body and logs a warning for stripped params.
 *
 * If no allowlist exists for the alias, returns the body unchanged (passthrough).
 */
export function filterRequestBody(
  body: Record<string, unknown>,
  allowlists: Map<string, Set<string>>,
  alias: string,
): Record<string, unknown> {
  const allowed = allowlists.get(alias);
  if (!allowed) return body;

  const stripped: string[] = [];
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) {
      filtered[key] = value;
    } else {
      stripped.push(key);
    }
  }

  if (stripped.length > 0) {
    logger.warn(
      "Stripped unknown params from '%s': %s",
      alias,
      stripped.join(", "),
    );
  }

  return filtered;
}
