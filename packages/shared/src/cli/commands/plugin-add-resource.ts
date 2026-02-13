import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cancel, intro, isCancel, outro, select, text } from "@clack/prompts";
import { Command } from "commander";
import {
  DEFAULT_PERMISSION_BY_TYPE,
  getDefaultFieldsForType,
  humanizeResourceType,
  RESOURCE_TYPE_OPTIONS,
  resourceKeyFromType,
} from "../plugin-create/resource-defaults.js";
import { validateManifest } from "../plugin-validate/validate-manifest.js";

interface ManifestWithResources {
  $schema?: string;
  name: string;
  displayName: string;
  description: string;
  resources: {
    required: unknown[];
    optional: unknown[];
  };
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

  let raw: string;
  let manifest: ManifestWithResources;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const result = validateManifest(parsed, manifestPath);
    if (!result.valid || !result.manifest) {
      console.error(
        "Invalid manifest. Run `appkit plugin validate` for details.",
      );
      process.exit(1);
    }
    manifest = parsed as ManifestWithResources;
  } catch (err) {
    console.error(
      "Failed to read or parse manifest.json:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  const resourceType = await select({
    message: "Resource type",
    options: RESOURCE_TYPE_OPTIONS.map((o) => ({
      value: o.value,
      label: o.label,
    })),
  });
  if (isCancel(resourceType)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const required = await select<boolean>({
    message: "Required or optional?",
    options: [
      { value: true, label: "Required", hint: "plugin needs it to function" },
      { value: false, label: "Optional", hint: "enhances functionality" },
    ],
  });
  if (isCancel(required)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const description = await text({
    message: "Short description for this resource",
    placeholder: required ? "Required for …" : "Optional for …",
  });
  if (isCancel(description)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const type = resourceType as string;
  const permission = DEFAULT_PERMISSION_BY_TYPE[type] ?? "CAN_VIEW";
  const fields = getDefaultFieldsForType(type);
  const alias = humanizeResourceType(type);
  const resourceKey = resourceKeyFromType(type);
  const entry = {
    type,
    alias,
    resourceKey,
    description:
      (description as string)?.trim() || `Required for ${alias} functionality.`,
    permission,
    fields,
  };

  if (required) {
    manifest.resources.required.push(entry);
  } else {
    manifest.resources.optional.push(entry);
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  outro("Resource added.");
  console.log(
    `\nAdded ${alias} as ${required ? "required" : "optional"} to ${path.relative(cwd, manifestPath)}`,
  );
}

export const pluginAddResourceCommand = new Command("add-resource")
  .description(
    "Add a resource requirement to an existing plugin manifest (interactive)",
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
