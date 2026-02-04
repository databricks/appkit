import type { PluginConstructor } from "shared";
import { ConfigurationError } from "../errors";
import { createLogger } from "../logging/logger";
import type { PluginManifest } from "./types";

const logger = createLogger("manifest-loader");

/**
 * Loads and validates the manifest from a plugin constructor.
 *
 * All plugins must have a static `manifest` property that declares their
 * metadata and resource requirements.
 *
 * @param plugin - The plugin constructor class
 * @returns The validated plugin manifest
 * @throws {ConfigurationError} If the manifest is missing or invalid
 *
 * @example
 * ```typescript
 * import { AnalyticsPlugin } from '@databricks/appkit';
 * import { getPluginManifest } from './manifest-loader';
 *
 * const manifest = getPluginManifest(AnalyticsPlugin);
 * console.log('Required resources:', manifest.resources.required);
 * ```
 */
export function getPluginManifest(plugin: PluginConstructor): PluginManifest {
  const pluginName = plugin.name || "unknown";

  try {
    // Check for static manifest property
    if (!plugin.manifest) {
      throw new ConfigurationError(
        `Plugin ${pluginName} is missing a manifest. All plugins must declare a static manifest property.`,
      );
    }

    // Validate manifest structure
    const manifest = plugin.manifest;

    if (!manifest.name || typeof manifest.name !== "string") {
      throw new ConfigurationError(
        `Plugin ${pluginName} manifest has missing or invalid 'name' field`,
      );
    }

    if (!manifest.displayName || typeof manifest.displayName !== "string") {
      throw new ConfigurationError(
        `Plugin ${manifest.name} manifest has missing or invalid 'displayName' field`,
      );
    }

    if (!manifest.description || typeof manifest.description !== "string") {
      throw new ConfigurationError(
        `Plugin ${manifest.name} manifest has missing or invalid 'description' field`,
      );
    }

    if (!manifest.resources) {
      throw new ConfigurationError(
        `Plugin ${manifest.name} manifest is missing 'resources' field`,
      );
    }

    if (!Array.isArray(manifest.resources.required)) {
      throw new ConfigurationError(
        `Plugin ${manifest.name} manifest has invalid 'resources.required' field (expected array)`,
      );
    }

    if (
      manifest.resources.optional &&
      !Array.isArray(manifest.resources.optional)
    ) {
      throw new ConfigurationError(
        `Plugin ${manifest.name} manifest has invalid 'resources.optional' field (expected array)`,
      );
    }

    logger.debug(
      "Loaded manifest for plugin %s: %d required resources, %d optional resources",
      manifest.name,
      manifest.resources.required.length,
      manifest.resources.optional?.length || 0,
    );

    // Cast to appkit PluginManifest type (structurally compatible, just more specific types)
    return manifest as unknown as PluginManifest;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(
      `Error loading manifest from plugin ${pluginName}: ${error}`,
    );
  }
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
