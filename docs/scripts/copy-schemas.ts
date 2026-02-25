/**
 * Copies JSON schemas from packages to docs/static for hosting.
 *
 * Schemas are served at:
 * https://databricks.github.io/appkit/schemas/{schema-name}.json
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCHEMAS_SOURCE = join(__dirname, "../../packages/shared/src/schemas");
const SCHEMAS_DEST = join(__dirname, "../static/schemas");

function copySchemas() {
  console.log("Copying JSON schemas to docs/static/schemas...");

  // Ensure destination directory exists
  if (!existsSync(SCHEMAS_DEST)) {
    mkdirSync(SCHEMAS_DEST, { recursive: true });
  }

  // Check if source directory exists
  if (!existsSync(SCHEMAS_SOURCE)) {
    console.warn(`Schemas source directory not found: ${SCHEMAS_SOURCE}`);
    return;
  }

  // Copy all .json files
  const files = readdirSync(SCHEMAS_SOURCE).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const src = join(SCHEMAS_SOURCE, file);
    const dest = join(SCHEMAS_DEST, file);
    copyFileSync(src, dest);
    console.log(`  Copied: ${file}`);
  }

  console.log(`Done! ${files.length} schema(s) copied.`);
}

copySchemas();
