import fs from "node:fs/promises";
import { createLogger } from "../../logging/logger";
import {
  objectMemberValue,
  objectTopLevelKeys,
  splitEntryBlocks,
} from "../../type-generator/embedded-cache";

const logger = createLogger("serving:schema-filter");

/** Registry interface name whose members hold the serving type blocks. */
const SERVING_INTERFACE = "ServingEndpointRegistry";

/**
 * Load per-endpoint request-parameter allowlists from the committed generated
 * `serving.d.ts`. The allowlist for an alias is the set of top-level keys of
 * its rendered `request` object type (`stream` is already excluded at
 * generation time). A generic `Record<string, unknown>` request has no keys, so
 * it yields no allowlist (passthrough). A missing file → no filtering
 * (passthrough).
 */
export async function loadEndpointSchemas(
  typesFile: string,
): Promise<Map<string, Set<string>>> {
  const allowlists = new Map<string, Set<string>>();

  try {
    const source = await fs.readFile(typesFile, "utf8");
    const blocks = splitEntryBlocks(source, SERVING_INTERFACE);
    for (const [alias, block] of Object.entries(blocks)) {
      // Each member is `{ request: <type>; response: ...; chunk: ...; }`.
      // Extract the `request` value, then its top-level object keys.
      const requestType = objectMemberValue(block, "request");
      if (!requestType) continue;
      const keys = objectTopLevelKeys(requestType);
      if (keys.length > 0) {
        allowlists.set(alias, new Set(keys));
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        "Failed to load serving types for request filtering: %s",
        (err as Error).message,
      );
    }
    // No file → no filtering, passthrough mode
  }

  return allowlists;
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
  filterMode: "strip" | "reject" = "strip",
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
    if (filterMode === "reject") {
      throw new Error(`Unknown request parameters: ${stripped.join(", ")}`);
    }
    logger.warn(
      "Stripped unknown params from '%s': %s",
      alias,
      stripped.join(", "),
    );
  }

  return filtered;
}
