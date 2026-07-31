/**
 * Reads the app's resolved template manifest (`appkit.plugins.json`) and
 * flattens each plugin's declared resources into the flat {@link ResourceTarget}
 * shape the checks consume. Offline and SDK-free — parses the same file
 * `appkit plugin list` reads.
 */

import fs from "node:fs";
import path from "node:path";
import type { ResourceTarget } from "./types";
import { errorMessage } from "./utils";

export const DEFAULT_MANIFEST_FILE = "appkit.plugins.json";

interface ManifestField {
  env?: string;
  /** Static default value baked into the manifest. */
  value?: string;
  origin?: "user" | "platform" | "static" | "cli";
  /** Only generated into the local .env; the platform injects it at deploy. */
  localOnly?: boolean;
}

interface ManifestResource {
  type: string;
  resourceKey: string;
  alias?: string;
  permission: string;
  fields?: Record<string, ManifestField>;
}

interface ManifestPlugin {
  resources?: {
    required?: ManifestResource[];
    optional?: ManifestResource[];
  };
  /**
   * True when the plugin is actually used by the app (imported and passed to
   * `createApp`). `plugin sync` discovers *every* plugin shipped by installed
   * packages but only marks the used ones; doctor checks only those, so an
   * unused built-in doesn't produce phantom "missing env var" errors.
   */
  requiredByTemplate?: boolean;
}

interface TemplateManifest {
  plugins?: Record<string, ManifestPlugin>;
}

/** A field's env var is the developer's to supply only when it has no static
 * default and isn't platform-injected at deploy time. */
function isUserSuppliedEnv(field: ManifestField): boolean {
  if (field.value !== undefined) return false;
  if (field.origin === "platform" || field.origin === "static") return false;
  if (field.localOnly) return false;
  return true;
}

/** Env vars the config layer should presence-check (i.e. user-supplied ones). */
function envVarsOf(resource: ManifestResource): string[] {
  const fields = resource.fields ?? {};
  const envs: string[] = [];
  for (const field of Object.values(fields)) {
    if (field?.env && isUserSuppliedEnv(field)) envs.push(field.env);
  }
  return envs;
}

/** Resolves each field's value keyed by manifest field name, preferring the
 * environment over a static `value` default. Unset/empty fields are omitted. */
function fieldValuesOf(resource: ManifestResource): Record<string, string> {
  const fields = resource.fields ?? {};
  const values: Record<string, string> = {};
  for (const [fieldName, field] of Object.entries(fields)) {
    if (!field) continue;
    const envValue = field.env ? process.env[field.env] : undefined;
    const resolved =
      envValue !== undefined && envValue.trim().length > 0
        ? envValue
        : field.value;
    if (resolved !== undefined && resolved.trim().length > 0) {
      values[fieldName] = resolved;
    }
  }
  return values;
}

function toTarget(
  plugin: string,
  resource: ManifestResource,
  required: boolean,
): ResourceTarget {
  return {
    type: resource.type,
    resourceKey: resource.resourceKey,
    alias: resource.alias ?? resource.resourceKey,
    plugin,
    requiredPermission: resource.permission,
    required,
    envVars: envVarsOf(resource),
    fieldValues: fieldValuesOf(resource),
  };
}

/** @throws if the file cannot be read or parsed. */
export function targetsFromManifestFile(
  manifestPath: string,
): ResourceTarget[] {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read manifest file ${manifestPath}: ${errorMessage(err)}`,
    );
  }

  let data: TemplateManifest;
  try {
    data = JSON.parse(raw) as TemplateManifest;
  } catch (err) {
    throw new Error(
      `Failed to parse manifest file ${manifestPath}: ${errorMessage(err)}`,
    );
  }

  // `plugin sync` catalogues every plugin the installed packages ship, marking
  // only those wired into `createApp` with `requiredByTemplate`. Check exactly
  // those, else doctor reports phantom "missing env var" errors for unimported
  // plugins.
  // KNOWN LIMITATION: sync strips `requiredByTemplate` for non-GA plugins, so a
  // used beta/experimental plugin is not checked here yet. See the README.
  const selected = Object.entries(data.plugins ?? {}).filter(
    ([, plugin]) => plugin.requiredByTemplate === true,
  );

  const targets: ResourceTarget[] = [];
  for (const [pluginName, plugin] of selected) {
    const resources = plugin.resources ?? {};
    for (const resource of resources.required ?? []) {
      targets.push(toTarget(pluginName, resource, true));
    }
    for (const resource of resources.optional ?? []) {
      targets.push(toTarget(pluginName, resource, false));
    }
  }
  return targets;
}

/** Returns an empty list if the manifest is absent — an app may legitimately
 * declare no resources. */
export function resolveTargetsFromCwd(
  cwd: string = process.cwd(),
  manifestFile: string = DEFAULT_MANIFEST_FILE,
): ResourceTarget[] {
  const manifestPath = path.resolve(cwd, manifestFile);
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  return targetsFromManifestFile(manifestPath);
}
