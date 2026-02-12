/**
 * Resource Registry Singleton
 *
 * Central registry that tracks all resource requirements across all plugins.
 * Provides global visibility into Databricks resources needed by the application
 * and handles deduplication when multiple plugins require the same resource.
 */

import type { BasePluginConfig, PluginConstructor, PluginData } from "shared";
import { ConfigurationError } from "../errors";
import { createLogger } from "../logging/logger";
import { getPluginManifest } from "./manifest-loader";
import type {
  ResourceEntry,
  ResourcePermission,
  ResourceRequirement,
  ValidationResult,
} from "./types";

const logger = createLogger("resource-registry");

/**
 * Permission hierarchy for merging logic.
 * Higher index = more permissive.
 */
const PERMISSION_HIERARCHY: ResourcePermission[] = [
  "CAN_VIEW",
  "READ",
  "CAN_USE",
  "WRITE",
  "EXECUTE",
  "CAN_MANAGE",
];

/**
 * Returns the most permissive permission between two permissions.
 */
function getMostPermissivePermission(
  p1: ResourcePermission,
  p2: ResourcePermission,
): ResourcePermission {
  const index1 = PERMISSION_HIERARCHY.indexOf(p1);
  const index2 = PERMISSION_HIERARCHY.indexOf(p2);
  return index1 > index2 ? p1 : p2;
}

/**
 * Generates a unique key for a resource based on type and alias.
 */
function getResourceKey(type: string, alias: string): string {
  return `${type}:${alias}`;
}

/**
 * Central registry for tracking plugin resource requirements.
 * Implements singleton pattern to ensure a single source of truth.
 */
export class ResourceRegistry {
  private static instance: ResourceRegistry | null = null;
  private resources: Map<string, ResourceEntry> = new Map();

  /**
   * Private constructor to enforce singleton pattern.
   */
  private constructor() {}

  /**
   * Gets the singleton instance of the ResourceRegistry.
   * Creates a new instance if one doesn't exist.
   */
  public static getInstance(): ResourceRegistry {
    if (!ResourceRegistry.instance) {
      ResourceRegistry.instance = new ResourceRegistry();
    }
    return ResourceRegistry.instance;
  }

  /**
   * Resets the singleton instance.
   * Primarily used for testing to ensure clean state between tests.
   */
  public static resetInstance(): void {
    ResourceRegistry.instance = null;
  }

  /**
   * Registers a resource requirement for a plugin.
   * If a resource with the same type+alias already exists, merges them:
   * - Combines plugin names (comma-separated)
   * - Uses the most permissive permission
   * - Marks as required if any plugin requires it
   * - Combines descriptions if they differ
   * - Keeps the env variable (or merges if they differ)
   *
   * @param plugin - Name of the plugin registering the resource
   * @param resource - Resource requirement specification
   */
  public register(plugin: string, resource: ResourceRequirement): void {
    const key = getResourceKey(resource.type, resource.alias);
    const existing = this.resources.get(key);

    if (existing) {
      // Merge with existing resource
      const merged = this.mergeResources(existing, plugin, resource);
      this.resources.set(key, merged);
    } else {
      // Create new resource entry
      const entry: ResourceEntry = {
        ...resource,
        plugin,
        resolved: false,
      };
      this.resources.set(key, entry);
    }
  }

  /**
   * Collects and registers resource requirements from an array of plugins.
   * For each plugin, loads its manifest to discover static resource declarations,
   * then checks for runtime resource requirements via `getResourceRequirements()`.
   *
   * Plugins without manifests are silently skipped (allowed for legacy plugins
   * or plugins that don't declare resources).
   *
   * @param rawPlugins - Array of plugin data entries from createApp configuration
   */
  public collectResources(
    rawPlugins: PluginData<PluginConstructor, unknown, string>[],
  ): void {
    for (const pluginData of rawPlugins) {
      if (!pluginData?.plugin) continue;

      const pluginName = pluginData.name;

      try {
        const manifest = getPluginManifest(pluginData.plugin);

        // Register required resources
        for (const resource of manifest.resources.required) {
          this.register(pluginName, { ...resource, required: true });
        }

        // Register optional resources
        for (const resource of manifest.resources.optional || []) {
          this.register(pluginName, { ...resource, required: false });
        }

        // Check for runtime resource requirements
        if (typeof pluginData.plugin.getResourceRequirements === "function") {
          const runtimeResources = pluginData.plugin.getResourceRequirements(
            pluginData.config as BasePluginConfig,
          );
          for (const resource of runtimeResources) {
            // Cast from shared's ResourceRequirement to registry's ResourceRequirement
            // The shared type has looser typing (string) vs registry (ResourceType enum)
            this.register(pluginName, resource as ResourceRequirement);
          }
        }

        logger.debug(
          "Collected resources from plugin %s: %d total",
          pluginName,
          this.getByPlugin(pluginName).length,
        );
      } catch (error) {
        // Plugin doesn't have a manifest - this is allowed for legacy plugins
        // or plugins that don't declare resources
        logger.debug(
          "Plugin %s has no manifest or invalid manifest: %s",
          pluginName,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /**
   * Merges a new resource requirement with an existing entry.
   * Applies intelligent merging logic for conflicting properties.
   */
  private mergeResources(
    existing: ResourceEntry,
    newPlugin: string,
    newResource: ResourceRequirement,
  ): ResourceEntry {
    // Combine plugin names if not already included
    const plugins = existing.plugin.split(", ");
    if (!plugins.includes(newPlugin)) {
      plugins.push(newPlugin);
    }

    // Use the most permissive permission
    const permission = getMostPermissivePermission(
      existing.permission,
      newResource.permission,
    );

    // Mark as required if any plugin requires it
    const required = existing.required || newResource.required;

    // Combine descriptions if they differ
    let description = existing.description;
    if (
      newResource.description &&
      newResource.description !== existing.description
    ) {
      // Check if the new description is already included
      if (!existing.description.includes(newResource.description)) {
        description = `${existing.description}; ${newResource.description}`;
      }
    }

    // Prefer existing fields when both have them (same type+alias)
    const fields = existing.fields ?? newResource.fields;

    return {
      ...existing,
      plugin: plugins.join(", "),
      permission,
      required,
      description,
      fields,
    };
  }

  /**
   * Retrieves all registered resources.
   * Returns a copy of the array to prevent external mutations.
   *
   * @returns Array of all registered resource entries
   */
  public getAll(): ResourceEntry[] {
    return Array.from(this.resources.values());
  }

  /**
   * Gets a specific resource by type and alias.
   *
   * @param type - Resource type
   * @param alias - Resource alias
   * @returns The resource entry if found, undefined otherwise
   */
  public get(type: string, alias: string): ResourceEntry | undefined {
    const key = getResourceKey(type, alias);
    return this.resources.get(key);
  }

  /**
   * Clears all registered resources.
   * Useful for testing or when rebuilding the registry.
   */
  public clear(): void {
    this.resources.clear();
  }

  /**
   * Returns the number of registered resources.
   */
  public size(): number {
    return this.resources.size;
  }

  /**
   * Gets all resources required by a specific plugin.
   *
   * @param pluginName - Name of the plugin
   * @returns Array of resources where the plugin is listed as a requester
   */
  public getByPlugin(pluginName: string): ResourceEntry[] {
    return this.getAll().filter((entry) =>
      entry.plugin.split(", ").includes(pluginName),
    );
  }

  /**
   * Gets all required resources (where required=true).
   *
   * @returns Array of required resource entries
   */
  public getRequired(): ResourceEntry[] {
    return this.getAll().filter((entry) => entry.required);
  }

  /**
   * Gets all optional resources (where required=false).
   *
   * @returns Array of optional resource entries
   */
  public getOptional(): ResourceEntry[] {
    return this.getAll().filter((entry) => !entry.required);
  }

  /**
   * Validates all registered resources against the environment.
   *
   * Checks each resource's field environment variables to determine if it's resolved.
   * Updates the `resolved` and `values` fields on each resource entry.
   *
   * Only required resources affect the `valid` status - optional resources
   * are checked but don't cause validation failure.
   *
   * @returns ValidationResult with validity status, missing resources, and all resources
   *
   * @example
   * ```typescript
   * const registry = ResourceRegistry.getInstance();
   * const result = registry.validate();
   *
   * if (!result.valid) {
   *   console.error("Missing resources:", result.missing.map(r => Object.values(r.fields).map(f => f.env)));
   * }
   * ```
   */
  public validate(): ValidationResult {
    const missing: ResourceEntry[] = [];

    for (const entry of this.resources.values()) {
      const values: Record<string, string> = {};
      let allSet = true;
      for (const [fieldName, fieldDef] of Object.entries(entry.fields)) {
        const val = process.env[fieldDef.env];
        if (val !== undefined && val !== "") {
          values[fieldName] = val;
        } else {
          allSet = false;
        }
      }
      if (allSet) {
        entry.resolved = true;
        entry.values = values;
        logger.debug(
          "Resource %s:%s resolved from fields",
          entry.type,
          entry.alias,
        );
      } else {
        entry.resolved = false;
        entry.values = Object.keys(values).length > 0 ? values : undefined;
        if (entry.required) {
          missing.push(entry);
          logger.debug(
            "Required resource %s:%s missing (fields: %s)",
            entry.type,
            entry.alias,
            Object.keys(entry.fields).join(", "),
          );
        } else {
          logger.debug(
            "Optional resource %s:%s not configured (fields: %s)",
            entry.type,
            entry.alias,
            Object.keys(entry.fields).join(", "),
          );
        }
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      all: this.getAll(),
    };
  }

  /**
   * Validates all registered resources and enforces the result.
   *
   * - In production: throws a {@link ConfigurationError} if any required resources are missing.
   * - In development (`NODE_ENV=development`): logs a warning but continues.
   * - When all resources are valid: logs a debug message with the count.
   *
   * @returns ValidationResult with validity status, missing resources, and all resources
   * @throws {ConfigurationError} In production when required resources are missing
   */
  public enforceValidation(): ValidationResult {
    const validation = this.validate();
    const isDevelopment = process.env.NODE_ENV === "development";

    if (!validation.valid) {
      const errorMessage = ResourceRegistry.formatMissingResources(
        validation.missing,
      );

      if (isDevelopment) {
        logger.warn(
          "Missing resources detected (continuing in dev mode):\n%s",
          errorMessage,
        );
      } else {
        throw new ConfigurationError(errorMessage, {
          context: {
            missingResources: validation.missing.map((r) => ({
              type: r.type,
              alias: r.alias,
              plugin: r.plugin,
              envVars: Object.values(r.fields).map((f) => f.env),
            })),
          },
        });
      }
    } else if (this.size() > 0) {
      logger.debug("All %d resources validated successfully", this.size());
    }

    return validation;
  }

  /**
   * Formats missing resources into a human-readable error message.
   *
   * @param missing - Array of missing resource entries
   * @returns Formatted error message string
   */
  public static formatMissingResources(missing: ResourceEntry[]): string {
    if (missing.length === 0) {
      return "No missing resources";
    }

    const lines = missing.map((entry) => {
      const envVars = Object.values(entry.fields).map((f) => f.env);
      const envHint = ` (set ${envVars.join(", ")})`;
      return `  - ${entry.type}:${entry.alias} [${entry.plugin}]${envHint}`;
    });

    return `Missing required resources:\n${lines.join("\n")}`;
  }
}
