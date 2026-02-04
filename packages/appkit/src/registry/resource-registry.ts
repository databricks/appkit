/**
 * Resource Registry Singleton
 *
 * Central registry that tracks all resource requirements across all plugins.
 * Provides global visibility into Databricks resources needed by the application
 * and handles deduplication when multiple plugins require the same resource.
 */

import { createLogger } from "../logging/logger";
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

    // Handle env variable merging
    let env = existing.env;
    if (newResource.env && newResource.env !== existing.env) {
      // If env vars differ, prefer existing but note the conflict
      if (existing.env) {
        // Keep existing env, could log a warning here
        env = existing.env;
      } else {
        env = newResource.env;
      }
    } else if (newResource.env) {
      env = newResource.env;
    }

    return {
      ...existing,
      plugin: plugins.join(", "),
      permission,
      required,
      description,
      env,
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
   * Checks each resource's environment variable to determine if it's resolved.
   * Updates the `resolved` and `value` fields on each resource entry.
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
   *   console.error("Missing resources:", result.missing.map(r => r.env));
   * }
   * ```
   */
  public validate(): ValidationResult {
    const missing: ResourceEntry[] = [];

    for (const entry of this.resources.values()) {
      if (entry.env) {
        const value = process.env[entry.env];
        if (value) {
          entry.resolved = true;
          entry.value = value;
          logger.debug(
            "Resource %s:%s resolved from %s",
            entry.type,
            entry.alias,
            entry.env,
          );
        } else {
          entry.resolved = false;
          entry.value = undefined;

          // Only required resources affect validation
          if (entry.required) {
            missing.push(entry);
            logger.debug(
              "Required resource %s:%s missing (env: %s)",
              entry.type,
              entry.alias,
              entry.env,
            );
          } else {
            logger.debug(
              "Optional resource %s:%s not configured (env: %s)",
              entry.type,
              entry.alias,
              entry.env,
            );
          }
        }
      } else {
        // Resources without env vars are considered resolved
        // (they may be provided through other means like config)
        entry.resolved = true;
        logger.debug(
          "Resource %s:%s has no env var, marking as resolved",
          entry.type,
          entry.alias,
        );
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      all: this.getAll(),
    };
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
      const envHint = entry.env ? ` (set ${entry.env})` : "";
      return `  - ${entry.type}:${entry.alias} [${entry.plugin}]${envHint}`;
    });

    return `Missing required resources:\n${lines.join("\n")}`;
  }
}
