/**
 * Generates TypeScript interfaces from JSON Schemas using
 * json-schema-to-typescript. Single source of truth for structural types
 * shared between packages.
 *
 * Currently generates:
 *  - plugin-manifest.generated.ts (PluginManifest, ResourceRequirement, ...)
 *  - metric-source.generated.ts (MetricSourceConfiguration)
 *
 * Run from repo root: pnpm exec tsx tools/generate-schema-types.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";
import { formatWithBiome } from "./format-with-biome.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

interface SchemaJob {
  schemaPath: string;
  outPath: string;
  bannerSource: string;
  rootRename?: { fromTitle: string; toName: string };
}

const JOBS: SchemaJob[] = [
  {
    schemaPath: path.join(
      REPO_ROOT,
      "packages/shared/src/schemas/plugin-manifest.schema.json",
    ),
    outPath: path.join(
      REPO_ROOT,
      "packages/shared/src/schemas/plugin-manifest.generated.ts",
    ),
    bannerSource: "plugin-manifest.schema.json",
    rootRename: {
      fromTitle: "AppKit Plugin Manifest",
      toName: "PluginManifest",
    },
  },
  {
    schemaPath: path.join(
      REPO_ROOT,
      "packages/shared/src/schemas/metric-source.schema.json",
    ),
    outPath: path.join(
      REPO_ROOT,
      "packages/shared/src/schemas/metric-source.generated.ts",
    ),
    bannerSource: "metric-source.schema.json",
    rootRename: {
      fromTitle: "AppKit Metric Source Configuration",
      toName: "MetricSourceConfiguration",
    },
  },
];

async function compileOne(job: SchemaJob): Promise<void> {
  const banner = `// AUTO-GENERATED from ${job.bannerSource} — do not edit.
// Run: pnpm exec tsx tools/generate-schema-types.ts
`;

  const raw = await compileFromFile(job.schemaPath, {
    bannerComment: "",
    additionalProperties: false,
    strictIndexSignatures: false,
    unreachableDefinitions: true,
    format: false,
    style: { semi: true, singleQuote: false },
    customName: (schema) =>
      job.rootRename && schema.title === job.rootRename.fromTitle
        ? job.rootRename.toName
        : undefined,
  });

  // Post-processing: work around json-schema-to-typescript limitations that
  // have no config options. Track upstream: https://github.com/bcherny/json-schema-to-typescript/issues/428
  // allOf/if-then produces `{ [k: string]: unknown } & { … }` — strip the index-signature part.
  const output = raw.replace(/\{\s*\[k: string\]: unknown;?\s*\}\s*&\s*/g, "");

  const result = banner + output;

  fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
  fs.writeFileSync(job.outPath, result, "utf-8");
  formatWithBiome(job.outPath);
  console.log("Wrote", job.outPath);
}

async function main(): Promise<void> {
  for (const job of JOBS) {
    await compileOne(job);
  }
}

main();
