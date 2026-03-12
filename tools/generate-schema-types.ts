/**
 * Generates TypeScript interfaces from plugin-manifest.schema.json using
 * json-schema-to-typescript. Single source of truth for structural types
 * (ResourceFieldEntry, ResourceRequirement, PluginManifest).
 *
 * Run from repo root: pnpm exec tsx tools/generate-schema-types.ts
 */
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

// ---------------------------------------------------------------------------
// Post-processing transforms (json-schema-to-typescript has no config for these)
// ---------------------------------------------------------------------------

/** allOf/if-then produces `{ [k: string]: unknown } & { … }` — strip the index-signature part. */
function stripIndexSignatureIntersections(src: string): string {
  return src.replace(/\{\s*\[k: string\]: unknown;?\s*\}\s*&\s*/g, "");
}

/** Remove auto-generated "This interface was referenced by …" JSDoc paragraphs. */
function stripReferencedByJSDoc(src: string): string {
  // Whole comment block whose only content is the paragraph:
  src = src.replace(
    /\/\*\*\s*\n(?:\s*\*\s*\n)*\s*\*\s*This interface was referenced by[\s\S]*?\*\/\n/g,
    "",
  );
  // Trailing paragraph inside a block that also has a real description:
  src = src.replace(
    /\n\s*\*\s*\n\s*\*\s*This interface was referenced by[\s\S]*?(?=\s*\*\/)/g,
    "\n ",
  );
  // Collapse JSDoc blocks left with empty trailing lines into single-line form:
  src = src.replace(/\/\*\*\s*\n(\s*\*\s*[^\n]+)\n\s*\n\s*\*\//g, "/** $1 */");
  return src;
}

// ---------------------------------------------------------------------------

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
  let output = raw;
  output = stripIndexSignatureIntersections(output);
  output = stripReferencedByJSDoc(output);
  output = BANNER + output;

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, output, "utf-8");
  console.log("Wrote", OUT_PATH);
}

main();
