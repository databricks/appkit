/**
 * Generates per-stability barrel files that re-export built-in plugins, driven
 * by each plugin's manifest.json `stability` field. Single source of truth for
 * which subpath (`@databricks/appkit` vs `@databricks/appkit/beta`) ships each
 * plugin, so the manifest, the synced `appkit.plugins.json`, and the runtime
 * exports cannot drift apart.
 *
 * Inputs:  packages/appkit/src/plugins/<name>/manifest.json
 * Outputs: packages/appkit/src/plugins/ga-exports.generated.ts
 *          packages/appkit/src/plugins/beta-exports.generated.ts
 *
 * Run from repo root: pnpm exec tsx tools/generate-plugin-entries.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatWithBiome } from "./format-with-biome.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const PLUGINS_DIR = path.join(REPO_ROOT, "packages/appkit/src/plugins");
const GA_OUT = path.join(PLUGINS_DIR, "ga-exports.generated.ts");
const BETA_OUT = path.join(PLUGINS_DIR, "beta-exports.generated.ts");

const HEADER = `// AUTO-GENERATED from packages/appkit/src/plugins/<name>/manifest.json — do not edit.
// Run: pnpm exec tsx tools/generate-plugin-entries.ts
//
// The manifest's "stability" field is the single source of truth for which
// subpath ships each plugin. Editing this file by hand will drift it from the
// manifests and the synced appkit.plugins.json.
`;

interface PluginInfo {
  name: string;
  folder: string;
  stability: "beta" | "ga";
}

/**
 * Mirrors `^[a-z][a-z0-9-]*$` from `plugin-manifest.schema.json`. Catches
 * malformed manifests that bypassed `appkit plugin validate`.
 */
const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Generator-only: the `name` field is interpolated unescaped into a TS
 * `export { <name> } from "./<folder>";` template, so it MUST be a valid
 * JavaScript identifier. The schema accepts hyphens (e.g. "my-plugin"),
 * which would produce `export { my-plugin }` — a TypeScript syntax error.
 *
 * This is also a defense-in-depth gate against code-injection (CWE-94)
 * via a malicious `name` containing `}`, `;`, quotes, newlines, etc.
 *
 * Restricted to camelCase / underscore identifiers starting with a lowercase
 * letter to match the existing built-in plugins (`analytics`, `lakebase`,
 * `vectorSearch`, …) and the schema's lowercase-first rule.
 */
const JS_IDENTIFIER_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;

function validateIdentifier(
  value: string,
  kind: "manifest name" | "folder name",
  manifestPath: string,
): void {
  if (!SCHEMA_NAME_PATTERN.test(value)) {
    throw new Error(
      `${kind} "${value}" in ${manifestPath} doesn't match the plugin manifest schema pattern ^[a-z][a-z0-9-]*$. Run \`appkit plugin validate\` to catch this earlier.`,
    );
  }
  if (!JS_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `${kind} "${value}" in ${manifestPath} is not a valid JavaScript identifier (must match ^[a-z][a-zA-Z0-9_]*$). The generator interpolates this name into \`export { ${value} } from "./<folder>";\` and would emit invalid TypeScript. Rename the plugin folder + manifest \`name\` to camelCase, or set \`hidden: true\` to exclude it from the auto-generated barrels.`,
    );
  }
}

function readPluginInfos(): PluginInfo[] {
  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const infos: PluginInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(PLUGINS_DIR, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    const raw = fs.readFileSync(manifestPath, "utf-8");
    let manifest: {
      name?: string;
      stability?: string;
      hidden?: boolean;
    };
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (manifest.hidden) continue;
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`Manifest missing "name": ${manifestPath}`);
    }

    // Both the manifest `name` (used as the exported binding) and the
    // folder name (used as the `from` path) flow into a TS source file
    // unescaped. Validate both against the schema and the JS-identifier
    // rule before we emit anything.
    validateIdentifier(manifest.name, "manifest name", manifestPath);
    validateIdentifier(entry.name, "folder name", manifestPath);

    const tier = manifest.stability ?? "ga";
    if (tier !== "ga" && tier !== "beta") {
      throw new Error(
        `Manifest at ${manifestPath} has invalid stability "${tier}". Must be "beta" or "ga".`,
      );
    }

    infos.push({
      name: manifest.name,
      folder: entry.name,
      stability: tier,
    });
  }

  // Deterministic order so re-runs produce reproducible diffs.
  infos.sort((a, b) => a.name.localeCompare(b.name));
  return infos;
}

function renderBarrel(infos: PluginInfo[]): string {
  if (infos.length === 0) {
    return `${HEADER}\nexport {};\n`;
  }
  const lines = infos.map((p) => `export { ${p.name} } from "./${p.folder}";`);
  return `${HEADER}\n${lines.join("\n")}\n`;
}

function main(): void {
  const infos = readPluginInfos();
  const ga = infos.filter((p) => p.stability === "ga");
  const beta = infos.filter((p) => p.stability === "beta");

  fs.writeFileSync(GA_OUT, renderBarrel(ga), "utf-8");
  fs.writeFileSync(BETA_OUT, renderBarrel(beta), "utf-8");
  // Self-format so a fresh `pnpm build` doesn't leave the generated
  // barrels dirty against biome's canonical formatting (matches the
  // pattern set by tools/generate-schema-types.ts and
  // tools/generate-registry-types.ts after PR #324).
  formatWithBiome(GA_OUT);
  formatWithBiome(BETA_OUT);

  console.log(
    `Wrote ${path.relative(REPO_ROOT, GA_OUT)} (${ga.length} GA plugin${ga.length === 1 ? "" : "s"})`,
  );
  console.log(
    `Wrote ${path.relative(REPO_ROOT, BETA_OUT)} (${beta.length} beta plugin${beta.length === 1 ? "" : "s"})`,
  );
}

main();
