/**
 * Resource Registry
 *
 * Central registry that tracks all resource requirements across all plugins.
 * Provides visibility into Databricks resources needed by the application
 * and handles deduplication when multiple plugins require the same resource
 * (dedup key: type + resourceKey).
 *
 * Use `new ResourceRegistry()` for instance-scoped usage (e.g. createApp).
 * getInstance() / resetInstance() remain for backward compatibility in tests.
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
import { PERMISSION_HIERARCHY_BY_TYPE, type ResourceType } from "./types";

const logger = createLogger("resource-registry");

/**
 * Dedup key for registry: type + resourceKey (machine-stable).
 * alias is for UI/display only.
 */
function getDedupKey(type: string, resourceKey: string): string {
  return `${type}:${resourceKey}`;
}

/**
 * Returns the most permissive permission for a given resource type.
 * Uses per-type hierarchy; unknown permissions are treated as least permissive.
 */
function getMostPermissivePermission(
  resourceType: ResourceType,
  p1: ResourcePermission,
  p2: ResourcePermission,
): ResourcePermission {
  const hierarchy = PERMISSION_HIERARCHY_BY_TYPE[resourceType as ResourceType];
  const index1 = hierarchy?.indexOf(p1) ?? -1;
  const index2 = hierarchy?.indexOf(p2) ?? -1;
  return index1 > index2 ? p1 : p2;
}

/**
 * Central registry for tracking plugin resource requirements.
 * Deduplication uses type + resourceKey (machine-stable); alias is for display only.
 */
export class ResourceRegistry {
  private resources: Map<string, ResourceEntry> = new Map();

  /**
   * Registers a resource requirement for a plugin.
   * If a resource with the same type+resourceKey already exists, merges them:
   * - Combines plugin names (comma-separated)
   * - Uses the most permissive permission (per-type hierarchy)
   * - Marks as required if any plugin requires it
   * - Combines descriptions if they differ
   * - Merges fields; warns when same field name uses different env vars
   *
   * @param plugin - Name of the plugin registering the resource
   * @param resource - Resource requirement specification
   */
  public register(plugin: string, resource: ResourceRequirement): void {
    const key = getDedupKey(resource.type, resource.resourceKey);
    const existing = this.resources.get(key);

    if (existing) {
      // Merge with existing resource
      const merged = this.mergeResources(existing, plugin, resource);
      this.resources.set(key, merged);
    } else {
      // Create new resource entry with permission source tracking
      const entry: ResourceEntry = {
        ...resource,
        plugin,
        resolved: false,
        permissionSources: { [plugin]: resource.permission },
      };
      this.resources.set(key, entry);
    }
  }

  /**
   * Collects and registers resource requirements from an array of plugins.
   * For each plugin, loads its manifest (required) and runtime resource requirements.
   *
   * @param rawPlugins - Array of plugin data entries from createApp configuration
   * @throws {ConfigurationError} If any plugin is missing a manifest or manifest is invalid
   */
  public collectResources(
    rawPlugins: PluginData<PluginConstructor, unknown, string>[],
  ): void {
    for (const pluginData of rawPlugins) {
      if (!pluginData?.plugin) continue;

      const pluginName = pluginData.name;
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
          this.register(pluginName, resource as ResourceRequirement);
        }
      }

      logger.debug(
        "Collected resources from plugin %s: %d total",
        pluginName,
        this.getByPlugin(pluginName).length,
      );
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

    // Track per-plugin permission sources
    const permissionSources: Record<string, ResourcePermission> = {
      ...(existing.permissionSources ?? {}),
      [newPlugin]: newResource.permission,
    };

    // Use the most permissive permission for this resource type; warn when escalating
    const permission = getMostPermissivePermission(
      existing.type as ResourceType,
      existing.permission,
      newResource.permission,
    );

    if (permission !== existing.permission) {
      logger.warn(
        'Resource %s:%s permission escalated from "%s" to "%s" due to plugin "%s" ' +
          "(previously requested by: %s). Review plugin permissions to ensure least-privilege.",
        existing.type,
        existing.resourceKey,
        existing.permission,
        permission,
        newPlugin,
        existing.plugin,
      );
    }

    // Mark as required if any plugin requires it
    const required = existing.required || newResource.required;

    // Combine descriptions if they differ
    let description = existing.description;
    if (
      newResource.description &&
      newResource.description !== existing.description
    ) {
      if (!existing.description.includes(newResource.description)) {
        description = `${existing.description}; ${newResource.description}`;
      }
    }

    // Merge fields: union of field names; warn when same field name uses different env
    const fields = { ...(existing.fields ?? {}) };
    for (const [fieldName, newField] of Object.entries(
      newResource.fields ?? {},
    )) {
      const existingField = fields[fieldName];
      if (existingField) {
        if (existingField.env !== newField.env) {
          logger.warn(
            'Resource %s:%s field "%s": conflicting env vars "%s" (from %s) vs "%s" (from %s). Using first.',
            existing.type,
            existing.resourceKey,
            fieldName,
            existingField.env,
            existing.plugin,
            newField.env,
            newPlugin,
          );
        }
        // keep existing
      } else {
        fields[fieldName] = newField;
      }
    }

    return {
      ...existing,
      plugin: plugins.join(", "),
      permission,
      permissionSources,
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
   * Gets a specific resource by type and resourceKey (dedup key).
   *
   * @param type - Resource type
   * @param resourceKey - Stable machine key (not alias; alias is for display only)
   * @returns The resource entry if found, undefined otherwise
   */
  public get(type: string, resourceKey: string): ResourceEntry | undefined {
    return this.resources.get(getDedupKey(type, resourceKey));
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
        if (!fieldDef.env) continue;
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
   * - In development (`NODE_ENV=development`): logs a warning but continues, unless
   *   `APPKIT_STRICT_VALIDATION=true` is set, in which case throws like production.
   * - When all resources are valid: logs a debug message with the count.
   *
   * @returns ValidationResult with validity status, missing resources, and all resources
   * @throws {ConfigurationError} In production when required resources are missing, or in dev when APPKIT_STRICT_VALIDATION=true
   */
  public enforceValidation(): ValidationResult {
    const validation = this.validate();
    const isDevelopment = process.env.NODE_ENV === "development";
    const strictValidation =
      process.env.APPKIT_STRICT_VALIDATION === "true" ||
      process.env.APPKIT_STRICT_VALIDATION === "1";

    if (!validation.valid) {
      const errorMessage = ResourceRegistry.formatMissingResources(
        validation.missing,
      );

      const shouldThrow = !isDevelopment || strictValidation;

      if (shouldThrow) {
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

      // Dev mode without strict: use a visually prominent box so the warning can't be missed
      const banner = ResourceRegistry.formatDevWarningBanner(
        validation.missing,
      );
      logger.warn("\n%s", banner);
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

  /**
   * Formats a highly visible warning banner for dev-mode missing resources.
   * Uses box drawing to ensure the message is impossible to miss in scrolling logs.
   *
   * @param missing - Array of missing resource entries
   * @returns Formatted banner string
   */
  public static formatDevWarningBanner(missing: ResourceEntry[]): string {
    const contentLines: string[] = [
      "MISSING REQUIRED RESOURCES (dev mode — would fail in production)",
      "",
    ];

    for (const entry of missing) {
      const envVars = Object.values(entry.fields).map((f) => f.env);
      contentLines.push(
        `  ${entry.type}:${entry.alias}  (plugin: ${entry.plugin})`,
      );
      contentLines.push(`    Set: ${envVars.join(", ")}`);
    }

    contentLines.push("");
    contentLines.push(
      "Add these to your .env file or environment to suppress this warning.",
    );

    const maxLen = Math.max(...contentLines.map((l) => l.length));
    const border = "=".repeat(maxLen + 4);

    const boxed = contentLines.map((line) => `| ${line.padEnd(maxLen)} |`);

    return [border, ...boxed, border].join("\n");
  }
}
