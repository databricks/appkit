import { isCancel, select, text } from "@clack/prompts";
import {
  getDefaultFieldsForType,
  humanizeResourceType,
  PERMISSIONS_BY_TYPE,
  RESOURCE_TYPE_OPTIONS,
  resourceKeyFromType,
} from "./resource-defaults";

/** Full resource spec collected from prompts (shared by create and add-resource). */
export interface ResourceSpec {
  type: string;
  required: boolean;
  description: string;
  resourceKey: string;
  permission: string;
  fields: Record<string, { env: string; description?: string }>;
}

/**
 * Prompt for a single resource: type (optional), required, description, resourceKey, permission, and field env vars.
 * When type is provided (e.g. from create's multiselect), type prompt is skipped.
 */
export async function promptOneResource(opts?: {
  type?: string;
}): Promise<ResourceSpec | null> {
  let type = opts?.type;

  if (!type) {
    const resourceType = await select({
      message: "Resource type",
      options: RESOURCE_TYPE_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
      })),
    });
    if (isCancel(resourceType)) return null;
    type = resourceType as string;
  }

  const required = await select<boolean>({
    message: `${humanizeResourceType(type)} – required or optional?`,
    options: [
      { value: true, label: "Required", hint: "plugin needs it to function" },
      { value: false, label: "Optional", hint: "enhances functionality" },
    ],
  });
  if (isCancel(required)) return null;

  const description = await text({
    message: `Short description for ${humanizeResourceType(type)}`,
    placeholder: required ? "Required for …" : "Optional for …",
  });
  if (isCancel(description)) return null;

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
  if (isCancel(resourceKey)) return null;

  const typePermissions = PERMISSIONS_BY_TYPE[type] ?? ["CAN_VIEW"];
  let permission: string;
  if (typePermissions.length === 1) {
    permission = typePermissions[0];
  } else {
    const selected = await select({
      message: "Permission level",
      options: typePermissions.map((p) => ({ value: p, label: p })),
    });
    if (isCancel(selected)) return null;
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
    if (isCancel(envName)) return null;
    fields[fieldKey] = {
      env: (envName as string).trim(),
      ...(defaults.description ? { description: defaults.description } : {}),
    };
  }

  return {
    type,
    required: required as boolean,
    description: (description as string)?.trim() || "",
    resourceKey: (resourceKey as string).trim(),
    permission,
    fields,
  };
}
