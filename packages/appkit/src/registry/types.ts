/**
 * Resource Registry Type System
 *
 * This module defines the type system for the AppKit Resource Registry,
 * which enables plugins to declare their Databricks resource requirements
 * in a machine-readable format.
 *
 * Resource types are exposed as first-class citizens with their specific
 * permissions, making it simple for users to declare dependencies.
 * Internal tooling handles conversion to Databricks app.yaml format.
 */

/**
 * Supported resource types that plugins can depend on.
 * Each type has its own set of valid permissions.
 */
export enum ResourceType {
  /** Secret scope for secure credential storage */
  SECRET = "secret",

  /** Databricks Job for scheduled or triggered workflows */
  JOB = "job",

  /** Databricks SQL Warehouse for query execution */
  SQL_WAREHOUSE = "sql_warehouse",

  /** Model serving endpoint for ML inference */
  SERVING_ENDPOINT = "serving_endpoint",

  /** Unity Catalog Volume for file storage */
  VOLUME = "volume",

  /** Vector Search Index for similarity search */
  VECTOR_SEARCH_INDEX = "vector_search_index",

  /** Unity Catalog Function */
  UC_FUNCTION = "uc_function",

  /** Unity Catalog Connection for external data sources */
  UC_CONNECTION = "uc_connection",

  /** Database (Lakebase) for persistent storage */
  DATABASE = "database",

  /** Genie Space for AI assistant */
  GENIE_SPACE = "genie_space",

  /** MLflow Experiment for ML tracking */
  EXPERIMENT = "experiment",

  /** Databricks App dependency */
  APP = "app",
}

// ============================================================================
// Permissions per resource type
// ============================================================================

/** Permissions for SECRET resources */
export type SecretPermission = "MANAGE" | "READ" | "WRITE";

/** Permissions for JOB resources */
export type JobPermission = "CAN_MANAGE" | "CAN_MANAGE_RUN" | "CAN_VIEW";

/** Permissions for SQL_WAREHOUSE resources */
export type SqlWarehousePermission = "CAN_MANAGE" | "CAN_USE";

/** Permissions for SERVING_ENDPOINT resources */
export type ServingEndpointPermission = "CAN_MANAGE" | "CAN_QUERY" | "CAN_VIEW";

/** Permissions for VOLUME resources */
export type VolumePermission = "READ_VOLUME" | "WRITE_VOLUME";

/** Permissions for VECTOR_SEARCH_INDEX resources */
export type VectorSearchIndexPermission = "SELECT";

/** Permissions for UC_FUNCTION resources */
export type UcFunctionPermission = "EXECUTE";

/** Permissions for UC_CONNECTION resources */
export type UcConnectionPermission = "USE_CONNECTION";

/** Permissions for DATABASE resources */
export type DatabasePermission = "CAN_CONNECT_AND_CREATE";

/** Permissions for GENIE_SPACE resources */
export type GenieSpacePermission =
  | "CAN_EDIT"
  | "CAN_VIEW"
  | "CAN_RUN"
  | "CAN_MANAGE";

/** Permissions for EXPERIMENT resources */
export type ExperimentPermission = "CAN_READ" | "CAN_EDIT" | "CAN_MANAGE";

/** Permissions for APP resources */
export type AppPermission = "CAN_USE";

/**
 * Union of all possible permission levels across all resource types.
 */
export type ResourcePermission =
  | SecretPermission
  | JobPermission
  | SqlWarehousePermission
  | ServingEndpointPermission
  | VolumePermission
  | VectorSearchIndexPermission
  | UcFunctionPermission
  | UcConnectionPermission
  | DatabasePermission
  | GenieSpacePermission
  | ExperimentPermission
  | AppPermission;

/**
 * Permission hierarchy per resource type (weakest to strongest).
 * Used to compare permissions when merging; higher index = more permissive.
 * Unknown permissions are treated as less than any known permission.
 */
export const PERMISSION_HIERARCHY_BY_TYPE: Record<
  ResourceType,
  readonly ResourcePermission[]
> = {
  [ResourceType.SECRET]: ["READ", "WRITE", "MANAGE"],
  [ResourceType.JOB]: ["CAN_VIEW", "CAN_MANAGE_RUN", "CAN_MANAGE"],
  [ResourceType.SQL_WAREHOUSE]: ["CAN_USE", "CAN_MANAGE"],
  [ResourceType.SERVING_ENDPOINT]: ["CAN_VIEW", "CAN_QUERY", "CAN_MANAGE"],
  [ResourceType.VOLUME]: ["READ_VOLUME", "WRITE_VOLUME"],
  [ResourceType.VECTOR_SEARCH_INDEX]: ["SELECT"],
  [ResourceType.UC_FUNCTION]: ["EXECUTE"],
  [ResourceType.UC_CONNECTION]: ["USE_CONNECTION"],
  [ResourceType.DATABASE]: ["CAN_CONNECT_AND_CREATE"],
  [ResourceType.GENIE_SPACE]: ["CAN_VIEW", "CAN_RUN", "CAN_EDIT", "CAN_MANAGE"],
  [ResourceType.EXPERIMENT]: ["CAN_READ", "CAN_EDIT", "CAN_MANAGE"],
  [ResourceType.APP]: ["CAN_USE"],
} as const;

/** Set of valid permissions per type (for validation). */
export const PERMISSIONS_BY_TYPE: Record<
  ResourceType,
  readonly ResourcePermission[]
> = PERMISSION_HIERARCHY_BY_TYPE;

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
