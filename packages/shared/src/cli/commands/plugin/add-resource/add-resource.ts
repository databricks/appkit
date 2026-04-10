import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cancel, intro, outro } from "@clack/prompts";
import { Command } from "commander";
import { promptOneResource } from "../create/prompt-resource";
import {
  DEFAULT_PERMISSION_BY_TYPE,
  getDefaultFieldsForType,
  getValidResourceTypes,
  humanizeResourceType,
  resourceKeyFromType,
} from "../create/resource-defaults";
import { resolveManifestInDir } from "../manifest-resolve";
import type { PluginManifest, ResourceRequirement } from "../manifest-types";
import { validateManifest } from "../validate/validate-manifest";

/** Extended manifest type that preserves extra JSON fields (e.g. $schema, author, version) for round-trip writes. */
interface ManifestWithExtras extends PluginManifest {
  [key: string]: unknown;
}

interface AddResourceOptions {
  path?: string;
  type?: string;
  required?: boolean;
  resourceKey?: string;
  description?: string;
  permission?: string;
  fieldsJson?: string;
  dryRun?: boolean;
}

function loadManifest(
  pluginDir: string,
): { manifest: ManifestWithExtras; manifestPath: string } | null {
  const resolved = resolveManifestInDir(pluginDir, { allowJsManifest: true });

  if (!resolved) {
    console.error(
      `No manifest found in ${pluginDir}. This command requires manifest.json (manifest.js cannot be edited in place).`,
    );
    console.error(
      "  appkit plugin add-resource --path <dir-with-manifest.json>",
    );
    process.exit(1);
  }

  if (resolved.type !== "json") {
    console.error(
      `Editable manifest not found. add-resource only supports plugin directories that contain manifest.json (found ${path.basename(resolved.path)}).`,
    );
    process.exit(1);
  }

  const manifestPath = resolved.path;

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
    return { manifest: parsed as ManifestWithExtras, manifestPath };
  } catch (err) {
    console.error(
      "Failed to read or parse manifest.json:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

function buildEntry(
  type: string,
  opts: AddResourceOptions,
): { entry: ResourceRequirement; isRequired: boolean } {
  const alias = humanizeResourceType(type);
  const isRequired = opts.required !== false;

  let fields = getDefaultFieldsForType(type);
  if (opts.fieldsJson) {
    try {
      const parsed = JSON.parse(opts.fieldsJson) as Record<
        string,
        { env: string; description?: string }
      >;
      fields = { ...fields, ...parsed };
    } catch {
      console.error("Error: --fields-json must be valid JSON.");
      console.error(
        '  Example: --fields-json \'{"id":{"env":"MY_WAREHOUSE_ID"}}\'',
      );
      process.exit(1);
    }
  }

  const entry: ResourceRequirement = {
    type: type as ResourceRequirement["type"],
    alias,
    resourceKey: opts.resourceKey ?? resourceKeyFromType(type),
    description:
      opts.description ||
      `${isRequired ? "Required" : "Optional"} for ${alias} functionality.`,
    permission:
      opts.permission ?? DEFAULT_PERMISSION_BY_TYPE[type] ?? "CAN_VIEW",
    fields,
  };

  return { entry, isRequired };
}

function runNonInteractive(opts: AddResourceOptions): void {
  const cwd = process.cwd();
  const pluginDir = path.resolve(cwd, opts.path ?? ".");
  const loaded = loadManifest(pluginDir);
  if (!loaded) return;
  const { manifest, manifestPath } = loaded;

  const type = opts.type as string;
  const validTypes = getValidResourceTypes();
  if (!validTypes.includes(type)) {
    console.error(`Error: Unknown resource type "${type}".`);
    console.error(`  Valid types: ${validTypes.join(", ")}`);
    process.exit(1);
  }
  const { entry, isRequired } = buildEntry(type, opts);

  if (isRequired) {
    manifest.resources.required.push(entry);
  } else {
    manifest.resources.optional.push(entry);
  }

  if (opts.dryRun) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Added ${entry.alias} as ${isRequired ? "required" : "optional"} to ${path.relative(cwd, manifestPath)}`,
  );
}

async function runInteractive(opts: AddResourceOptions): Promise<void> {
  intro("Add resource to plugin manifest");

  const cwd = process.cwd();
  const pluginDir = path.resolve(cwd, opts.path ?? ".");
  const loaded = loadManifest(pluginDir);
  if (!loaded) return;
  const { manifest, manifestPath } = loaded;

  const spec = await promptOneResource();
  if (!spec) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const alias = humanizeResourceType(spec.type);
  const entry: ResourceRequirement = {
    type: spec.type as ResourceRequirement["type"],
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

async function runPluginAddResource(opts: AddResourceOptions): Promise<void> {
  if (opts.type) {
    runNonInteractive(opts);
  } else {
    await runInteractive(opts);
  }
}

export const pluginAddResourceCommand = new Command("add-resource")
  .description(
    "Add a resource requirement to an existing plugin manifest. Overwrites manifest.json in place.",
  )
  .option(
    "-p, --path <dir>",
    "Plugin directory containing manifest.json (default: .)",
  )
  .option(
    "-t, --type <resource_type>",
    "Resource type (e.g. sql_warehouse, volume). Enables non-interactive mode.",
  )
  .option("--required", "Mark resource as required (default: true)", true)
  .option("--no-required", "Mark resource as optional")
  .option("--resource-key <key>", "Resource key (default: derived from type)")
  .option("--description <text>", "Description of the resource requirement")
  .option("--permission <perm>", "Permission level (default: from schema)")
  .option(
    "--fields-json <json>",
    'JSON object overriding field env vars (e.g. \'{"id":{"env":"MY_WAREHOUSE_ID"}}\')',
  )
  .option("--dry-run", "Preview the updated manifest without writing")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit plugin add-resource
  $ appkit plugin add-resource --path plugins/my-plugin --type sql_warehouse
  $ appkit plugin add-resource --path plugins/my-plugin --type volume --no-required --dry-run
  $ appkit plugin add-resource --type sql_warehouse --fields-json '{"id":{"env":"MY_WAREHOUSE_ID"}}'`,
  )
  .action((opts) =>
    runPluginAddResource(opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
