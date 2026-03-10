import type { PluginConstructor } from "shared";
import { ConfigurationError } from "../errors";
import { createLogger } from "../logging/logger";
import type {
  PluginManifest,
  ResourcePermission,
  ResourceRequirement,
} from "./types";
import { PERMISSIONS_BY_TYPE, ResourceType } from "./types";

const logger = createLogger("manifest-loader");

/** Loose resource from shared/manifest (string type and permission). */
interface LooseResource {
  type: string;
  alias: string;
  resourceKey: string;
  description: string;
  permission: string;
  fields: Record<string, { env: string; description?: string }>;
}

function normalizeType(s: string): ResourceType {
  const v = Object.values(ResourceType).find((x) => x === s);
  if (v !== undefined) return v;
  throw new ConfigurationError(
    `Invalid resource type: "${s}". Valid: ${Object.values(ResourceType).join(", ")}`,
  );
}

function normalizePermission(
  type: ResourceType,
  s: string,
): ResourcePermission {
  const allowed = PERMISSIONS_BY_TYPE[type];
  if (allowed.includes(s as ResourcePermission)) return s as ResourcePermission;
  throw new ConfigurationError(
    `Invalid permission "${s}" for type ${type}. Valid: ${allowed.join(", ")}`,
  );
}

function normalizeResource(r: LooseResource): ResourceRequirement {
  const type = normalizeType(r.type);
  const permission = normalizePermission(type, r.permission);
  return {
    ...r,
    type,
    permission,
    required: false,
  };
}

/**
 * Loads and validates the manifest from a plugin constructor.
 * Normalizes string type/permission to strict ResourceType/ResourcePermission.
 *
 * @param plugin - The plugin constructor class
 * @returns The validated, normalized plugin manifest
 * @throws {ConfigurationError} If the manifest is missing, invalid, or has invalid resource type/permission
 */
export function getPluginManifest(plugin: PluginConstructor): PluginManifest {
  const pluginName = plugin.manifest?.name || plugin.name || "unknown";

  if (!plugin.manifest) {
    throw new ConfigurationError(
      `Plugin ${pluginName} is missing a manifest. All plugins must declare a static manifest property.`,
    );
  }

  const raw = plugin.manifest;

  if (!raw.name || typeof raw.name !== "string") {
    throw new ConfigurationError(
      `Plugin ${pluginName} manifest has missing or invalid 'name' field`,
    );
  }

  if (!raw.displayName || typeof raw.displayName !== "string") {
    throw new ConfigurationError(
      `Plugin ${raw.name} manifest has missing or invalid 'displayName' field`,
    );
  }

  if (!raw.description || typeof raw.description !== "string") {
    throw new ConfigurationError(
      `Plugin ${raw.name} manifest has missing or invalid 'description' field`,
    );
  }

  if (!raw.resources) {
    throw new ConfigurationError(
      `Plugin ${raw.name} manifest is missing 'resources' field`,
    );
  }

  if (!Array.isArray(raw.resources.required)) {
    throw new ConfigurationError(
      `Plugin ${raw.name} manifest has invalid 'resources.required' field (expected array)`,
    );
  }

  if (
    raw.resources.optional !== undefined &&
    !Array.isArray(raw.resources.optional)
  ) {
    throw new ConfigurationError(
      `Plugin ${raw.name} manifest has invalid 'resources.optional' field (expected array)`,
    );
  }

  const required = raw.resources.required.map((r) => {
    const norm = normalizeResource(r as LooseResource);
    const { required: _, ...rest } = norm;
    return rest;
  });
  const optional = (raw.resources.optional || []).map((r) => {
    const norm = normalizeResource(r as LooseResource);
    const { required: _, ...rest } = norm;
    return rest;
  });

  logger.debug(
    "Loaded manifest for plugin %s: %d required resources, %d optional resources",
    raw.name,
    required.length,
    optional.length,
  );

  return {
    ...raw,
    resources: { required, optional },
  };
}

/**
 * Gets the resource requirements from a plugin's manifest.
 *
 * Combines required and optional resources into a single array with the
 * `required` flag set appropriately.
 *
 * @param plugin - The plugin constructor class
 * @returns Combined array of required and optional resources
 * @throws {ConfigurationError} If the plugin manifest is missing or invalid
 *
 * @example
 * ```typescript
 * const resources = getResourceRequirements(AnalyticsPlugin);
 * for (const resource of resources) {
 *   console.log(`${resource.type}: ${resource.description} (required: ${resource.required})`);
 * }
 * ```
 */
export function getResourceRequirements(plugin: PluginConstructor) {
  const manifest = getPluginManifest(plugin);

  const required = manifest.resources.required.map((r) => ({
    ...r,
    required: true,
  }));
  const optional = (manifest.resources.optional || []).map((r) => ({
    ...r,
    required: false,
  }));

  return [...required, ...optional];
}

/**
 * Validates a manifest object structure.
 *
 * @param manifest - The manifest object to validate
 * @returns true if the manifest is valid, false otherwise
 *
 * @internal
 */
export function isValidManifest(manifest: unknown): manifest is PluginManifest {
  if (!manifest || typeof manifest !== "object") {
    return false;
  }

  const m = manifest as Record<string, unknown>;

  // Check required fields
  if (typeof m.name !== "string") return false;
  if (typeof m.displayName !== "string") return false;
  if (typeof m.description !== "string") return false;

  // Check resources structure
  if (!m.resources || typeof m.resources !== "object") return false;

  const resources = m.resources as Record<string, unknown>;
  if (!Array.isArray(resources.required)) return false;

  // Optional field can be missing or must be an array
  if (resources.optional !== undefined && !Array.isArray(resources.optional)) {
    return false;
  }

  return true;
}
