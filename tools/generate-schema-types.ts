/**
 * Generates TypeScript interfaces from plugin-manifest.schema.json using
 * json-schema-to-typescript. Single source of truth for structural types
 * (ResourceFieldEntry, ResourceRequirement, PluginManifest).
 *
 * Run from repo root: pnpm exec tsx tools/generate-schema-types.ts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  "packages/shared/src/schemas/plugin-manifest.schema.json",
);
const OUT_PATH = path.join(
  REPO_ROOT,
  "packages/shared/src/schemas/plugin-manifest.generated.ts",
);

const BANNER = `// AUTO-GENERATED from plugin-manifest.schema.json — do not edit.
// Run: pnpm exec tsx tools/generate-schema-types.ts
`;

async function main(): Promise<void> {
  const raw = await compileFromFile(SCHEMA_PATH, {
    bannerComment: "",
    additionalProperties: false,
    strictIndexSignatures: false,
    unreachableDefinitions: true,
    format: false,
    style: { semi: true, singleQuote: false },
    // Rename the root type (derived from schema title "AppKit Plugin Manifest")
    // to "PluginManifest" for ergonomic imports.
    customName: (schema) =>
      schema.title === "AppKit Plugin Manifest" ? "PluginManifest" : undefined,
  });

  // Post-processing: work around json-schema-to-typescript limitations that
  // have no config options. Track upstream: https://github.com/bcherny/json-schema-to-typescript/issues/428
  // allOf/if-then produces `{ [k: string]: unknown } & { … }` — strip the index-signature part.
  const output = raw.replace(/\{\s*\[k: string\]: unknown;?\s*\}\s*&\s*/g, "");

  const result = BANNER + output;

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, result, "utf-8");
  formatWithBiome(OUT_PATH);
  console.log("Wrote", OUT_PATH);
}

/**
 * Run Biome on the generated file so its formatting matches the rest of the
 * repo. Without this, every `pnpm build`/`pnpm dev` would leave the file dirty
 * until `pnpm format` is run.
 */
function formatWithBiome(filePath: string): void {
  const result = spawnSync(
    "pnpm",
    ["exec", "biome", "check", "--write", "--no-errors-on-unmatched", filePath],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`biome check --write failed for ${filePath}`);
  }
}

main();
