/**
 * Generates JSON Schema artifacts from the Zod authoring module
 * (packages/shared/src/schemas/manifest.ts) and writes them into the docs
 * site's static schemas directory. Those files are what the published
 * docs URL serves to plugin authors' editors via $schema.
 *
 * Run from repo root: pnpm exec tsx tools/generate-json-schema.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  pluginManifestSchema,
  templatePluginsManifestSchema,
} from "../packages/shared/src/schemas/manifest";
import { formatWithBiome } from "./format-with-biome";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const DOCS_SCHEMAS_DIR = path.join(REPO_ROOT, "docs/static/schemas");

const PLUGIN_OUT_PATH = path.join(
  DOCS_SCHEMAS_DIR,
  "plugin-manifest.schema.json",
);
const TEMPLATE_OUT_PATH = path.join(
  DOCS_SCHEMAS_DIR,
  "template-plugins.schema.json",
);

const PLUGIN_SCHEMA_ID =
  "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json";
const TEMPLATE_SCHEMA_ID =
  "https://databricks.github.io/appkit/schemas/template-plugins.schema.json";

function emit(
  schema: z.ZodType,
  schemaId: string,
  title: string,
): Record<string, unknown> {
  // Targeting draft-07 keeps parity with the existing hand-written schemas
  // (which are draft-07). The default in Zod 4 is draft-2020-12.
  //
  // `io: "input"` makes Zod emit the pre-transform shape, so transforms
  // (like the `origin`-emitter on `templateFieldEntrySchema`) produce
  // valid JSON Schema instead of throwing "Transforms cannot be
  // represented in JSON Schema". For schemas without transforms, this is
  // equivalent to the default ("output").
  const generated = z.toJSONSchema(schema, {
    target: "draft-07",
    io: "input",
  });
  // Inject $id and title at the top level so editor tooling can identify
  // the schema by URL even when fetched out-of-band.
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: schemaId,
    title,
    ...stripTopLevelSchemaKey(generated),
  };
}

/**
 * Zod's `toJSONSchema` emits `$schema` at the root. We re-construct it in
 * a deterministic order alongside `$id` and `title`, so this strips the
 * key from the generated shape before merging.
 */
function stripTopLevelSchemaKey(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = obj;
  return rest;
}

function writeJson(outPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  formatWithBiome(outPath);
  console.log("Wrote", outPath);
}

async function main(): Promise<void> {
  const pluginJson = emit(
    pluginManifestSchema,
    PLUGIN_SCHEMA_ID,
    "AppKit Plugin Manifest",
  );
  const templateJson = emit(
    templatePluginsManifestSchema,
    TEMPLATE_SCHEMA_ID,
    "AppKit Template Plugins Manifest",
  );

  writeJson(PLUGIN_OUT_PATH, pluginJson);
  writeJson(TEMPLATE_OUT_PATH, templateJson);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
