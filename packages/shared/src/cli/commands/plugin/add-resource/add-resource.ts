import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cancel, intro, isCancel, outro, select, text } from "@clack/prompts";
import { Command } from "commander";
import {
  getDefaultFieldsForType,
  humanizeResourceType,
  PERMISSIONS_BY_TYPE,
  RESOURCE_TYPE_OPTIONS,
  resourceKeyFromType,
} from "../create/resource-defaults";
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

  let raw: string;
  let manifest: ManifestWithExtras;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
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
  const alias = humanizeResourceType(type);
  const defaultKey = resourceKeyFromType(type);

  const resourceKey = await text({
    message: "Resource key (unique identifier within the manifest)",
    initialValue: defaultKey,
    placeholder: defaultKey,
    validate: (val = "") => {
      if (!val.trim()) return "Resource key is required";
      if (!/^[a-z][a-z0-9-]*$/.test(val))
        return "Must be lowercase, start with a letter, and contain only letters, numbers, and hyphens";
    },
  });
  if (isCancel(resourceKey)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const typePermissions = PERMISSIONS_BY_TYPE[type] ?? ["CAN_VIEW"];
  let permission: string;
  if (typePermissions.length === 1) {
    permission = typePermissions[0];
  } else {
    const selected = await select({
      message: "Permission level",
      options: typePermissions.map((p) => ({ value: p, label: p })),
    });
    if (isCancel(selected)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    permission = selected as string;
  }

  const defaultFields = getDefaultFieldsForType(type);
  const fields: Record<string, { env: string; description?: string }> = {};

  for (const [fieldKey, defaults] of Object.entries(defaultFields)) {
    const envName = await text({
      message: `Env var for "${fieldKey}"${defaults.description ? ` (${defaults.description})` : ""}`,
      initialValue: defaults.env,
      placeholder: defaults.env,
      validate: (val = "") => {
        if (!val.trim()) return "Env var name is required";
        if (!/^[A-Z][A-Z0-9_]*$/.test(val))
          return "Must be uppercase, start with a letter (e.g. DATABRICKS_WAREHOUSE_ID)";
      },
    });
    if (isCancel(envName)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    fields[fieldKey] = {
      env: (envName as string).trim(),
      ...(defaults.description ? { description: defaults.description } : {}),
    };
  }

  const entry = {
    type,
    alias,
    resourceKey: (resourceKey as string).trim(),
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
