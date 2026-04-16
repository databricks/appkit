import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../logging/logger";

const logger = createLogger("type-generator:migration");

/**
 * Remove old generated types from client/src/appkit-types/ (pre-shared/ location).
 * Best-effort: silently ignores missing files.
 */
export async function removeOldGeneratedTypes(
  newOutFile: string,
  filename: string,
): Promise<void> {
  const projectRoot = path.resolve(path.dirname(newOutFile), "..", "..");
  const oldFile = path.join(
    projectRoot,
    "client",
    "src",
    "appkit-types",
    filename,
  );
  try {
    await fs.unlink(oldFile);
    logger.debug("Removed old types at %s", oldFile);
  } catch {
    // File doesn't exist — nothing to clean up
  }
}
