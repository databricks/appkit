/**
 * Resource Registry Type System
 *
 * This module defines the type system for the AppKit Resource Registry,
 * which enables plugins to declare their Databricks resource requirements
 * in a machine-readable format.
 *
 * Resource types and permissions are generated from plugin-manifest.schema.json
 * (see types.generated.ts). Hand-written interfaces below define the registry API.
 */

// Re-export generated registry types (enum + const must be value exports for runtime)
import {
  type AppPermission,
  type DatabasePermission,
  type ExperimentPermission,
  type GenieSpacePermission,
  type JobPermission,
  PERMISSION_HIERARCHY_BY_TYPE,
  PERMISSIONS_BY_TYPE,
  type ResourcePermission,
  ResourceType,
  type SecretPermission,
  type ServingEndpointPermission,
  type SqlWarehousePermission,
  type UcConnectionPermission,
  type UcFunctionPermission,
  type VectorSearchIndexPermission,
  type VolumePermission,
} from "./types.generated";

export {
  PERMISSION_HIERARCHY_BY_TYPE,
  PERMISSIONS_BY_TYPE,
  ResourceType,
  type AppPermission,
  type DatabasePermission,
  type ExperimentPermission,
  type GenieSpacePermission,
  type JobPermission,
  type ResourcePermission,
  type SecretPermission,
  type ServingEndpointPermission,
  type SqlWarehousePermission,
  type UcConnectionPermission,
  type UcFunctionPermission,
  type VectorSearchIndexPermission,
  type VolumePermission,
};

// ============================================================================
// Hand-written interfaces (not in JSON schema)
// ============================================================================

/**
 * Defines a single field for a resource. Each field has its own environment variable and optional description.
 * Single-value types use one key (e.g. id); multi-value types (database, secret) use multiple (e.g. instance_name, database_name or scope, key).
 */
export interface ResourceFieldEntry {
  /** Environment variable name for this field */
  env: string;
  /** Human-readable description for this field */
  description?: string;
}

/**
 * Declares a resource requirement for a plugin.
 * Can be defined statically in a manifest or dynamically via getResourceRequirements().
 */
export interface ResourceRequirement {
  /** Type of Databricks resource required */
  type: ResourceType;

  /** Unique alias for this resource within the plugin (e.g., 'warehouse', 'secrets'). Used for UI/display. */
  alias: string;

  /** Stable key for machine use (env naming, composite keys, app.yaml). Required. */
  resourceKey: string;

  /** Human-readable description of why this resource is needed */
  description: string;

  /** Required permission level for the resource */
  permission: ResourcePermission;

  /**
   * Map of field name to env and optional description.
   * Single-value types use one key (e.g. id); multi-value (database, secret) use multiple keys.
   */
  fields: Record<string, ResourceFieldEntry>;

  /** Whether this resource is required (true) or optional (false) */
  required: boolean;
}

/**
 * Internal representation of a resource in the registry.
 * Extends ResourceRequirement with resolution state and plugin ownership.
 */
export interface ResourceEntry extends ResourceRequirement {
  /** Plugin(s) that require this resource (comma-separated if multiple) */
  plugin: string;

  /** Whether the resource has been resolved (all field env vars set) */
  resolved: boolean;

  /** Resolved value per field name. Populated by validate() when all field env vars are set. */
  values?: Record<string, string>;

  /**
   * Per-plugin permission tracking.
   * Maps plugin name to the permission it originally requested.
   * Populated when multiple plugins share the same resource.
   */
  permissionSources?: Record<string, ResourcePermission>;
}

/**
 * Result of validating all registered resources against the environment.
 */
export interface ValidationResult {
  /** Whether all required resources are available */
  valid: boolean;

  /** List of missing required resources */
  missing: ResourceEntry[];

  /** Complete list of all registered resources (required and optional) */
  all: ResourceEntry[];
}

import type { JSONSchema7 } from "json-schema";

/**
 * Configuration schema definition for plugin config.
 * Re-exported from the standard JSON Schema Draft 7 types.
 *
 * @see {@link https://json-schema.org/draft-07/json-schema-release-notes | JSON Schema Draft 7}
 */
export type ConfigSchema = JSONSchema7;

/**
 * Plugin manifest that declares metadata and resource requirements.
 * Attached to plugin classes as a static property.
 */
export interface PluginManifest {
  /** Plugin identifier (matches plugin.name) */
  name: string;

  /** Human-readable display name for UI/CLI */
  displayName: string;

  /** Brief description of what the plugin does */
  description: string;

  /**
   * Resource requirements declaration
   */
  resources: {
    /** Resources that must be available for the plugin to function */
    required: Omit<ResourceRequirement, "required">[];

    /** Resources that enhance functionality but are not mandatory */
    optional: Omit<ResourceRequirement, "required">[];
  };

  /**
   * Configuration schema for the plugin.
   * Defines the shape and validation rules for plugin config.
   */
  config?: {
    schema: ConfigSchema;
  };

  /**
   * Optional metadata for community plugins
   */
  author?: string;
  version?: string;
  repository?: string;
  keywords?: string[];
  license?: string;
}
