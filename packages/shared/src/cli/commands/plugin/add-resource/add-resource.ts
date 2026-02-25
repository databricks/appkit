import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cancel, intro, outro } from "@clack/prompts";
import { Command } from "commander";
import { promptOneResource } from "../create/prompt-resource";
import { humanizeResourceType } from "../create/resource-defaults";
import type { PluginManifest } from "../manifest-types";
import { validateManifest } from "../validate/validate-manifest";

/** Extended manifest type that preserves extra JSON fields (e.g. $schema, author, version) for round-trip writes. */
interface ManifestWithExtras extends PluginManifest {
  [key: string]: unknown;
}

async function runPluginAddResource(options: { path?: string }): Promise<void> {
  intro("Add resource to plugin manifest");

  const cwd = process.cwd();
  const pluginDir = path.resolve(cwd, options.path ?? ".");
  const manifestPath = path.join(pluginDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest.json not found at ${manifestPath}`);
    process.exit(1);
  }

  let manifest: ManifestWithExtras;
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const result = validateManifest(parsed);
    if (!result.valid || !result.manifest) {
      console.error(
        "Invalid manifest. Run `appkit plugin validate` for details.",
      );
      process.exit(1);
    }
    manifest = parsed as ManifestWithExtras;
  } catch (err) {
    console.error(
      "Failed to read or parse manifest.json:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  const spec = await promptOneResource();
  if (!spec) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const alias = humanizeResourceType(spec.type);
  const entry = {
    type: spec.type,
    alias,
    resourceKey: spec.resourceKey,
    description: spec.description || `Required for ${alias} functionality.`,
    permission: spec.permission,
    fields: spec.fields,
  };

  if (spec.required) {
    manifest.resources.required.push(entry);
  } else {
    manifest.resources.optional.push(entry);
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  outro("Resource added.");
  console.log(
    `\nAdded ${alias} as ${spec.required ? "required" : "optional"} to ${path.relative(cwd, manifestPath)}`,
  );
}

export const pluginAddResourceCommand = new Command("add-resource")
  .description(
    "Add a resource requirement to an existing plugin manifest (interactive). Overwrites manifest.json in place.",
  )
  .option(
    "-p, --path <dir>",
    "Plugin directory containing manifest.json (default: .)",
  )
  .action((opts) =>
    runPluginAddResource(opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
