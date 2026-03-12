// AUTO-GENERATED from plugin-manifest.schema.json — do not edit.
// Run: pnpm exec tsx tools/generate-schema-types.ts
export type ResourceRequirement = {
  type: ResourceType;
  /**
   * Human-readable label for UI/display only. Deduplication uses resourceKey, not alias.
   */
  alias: string;
  /**
   * Stable key for machine use: deduplication, env naming, composite keys, app.yaml. Required for registry lookup.
   */
  resourceKey: string;
  /**
   * Human-readable description of why this resource is needed
   */
  description: string;
  /**
   * Required permission level. Validated per resource type by the allOf/if-then rules below.
   */
  permission: string;
  /**
   * Map of field name to env and optional description. Single-value types use one key (e.g. id); multi-value (database, secret) use multiple (e.g. instance_name, database_name or scope, key).
   */
  fields?: {
    [k: string]: ResourceFieldEntry;
  };
};
/**  * Type of Databricks resource */
export type ResourceType =
  | "secret"
  | "job"
  | "sql_warehouse"
  | "serving_endpoint"
  | "volume"
  | "vector_search_index"
  | "uc_function"
  | "uc_connection"
  | "database"
  | "postgres"
  | "genie_space"
  | "experiment"
  | "app";
/**  * Permission for secret resources (order: weakest to strongest) */
export type SecretPermission = "READ" | "WRITE" | "MANAGE";
/**  * Permission for job resources (order: weakest to strongest) */
export type JobPermission = "CAN_VIEW" | "CAN_MANAGE_RUN" | "CAN_MANAGE";
/**  * Permission for SQL warehouse resources (order: weakest to strongest) */
export type SqlWarehousePermission = "CAN_USE" | "CAN_MANAGE";
/**  * Permission for serving endpoint resources (order: weakest to strongest) */
export type ServingEndpointPermission = "CAN_VIEW" | "CAN_QUERY" | "CAN_MANAGE";
/**  * Permission for Unity Catalog volume resources */
export type VolumePermission = "READ_VOLUME" | "WRITE_VOLUME";
/**  * Permission for vector search index resources */
export type VectorSearchIndexPermission = "SELECT";
/**  * Permission for Unity Catalog function resources */
export type UcFunctionPermission = "EXECUTE";
/**  * Permission for Unity Catalog connection resources */
export type UcConnectionPermission = "USE_CONNECTION";
/**  * Permission for database resources */
export type DatabasePermission = "CAN_CONNECT_AND_CREATE";
/**  * Permission for Postgres resources */
export type PostgresPermission = "CAN_CONNECT_AND_CREATE";
/**  * Permission for Genie Space resources (order: weakest to strongest) */
export type GenieSpacePermission =
  | "CAN_VIEW"
  | "CAN_RUN"
  | "CAN_EDIT"
  | "CAN_MANAGE";
/**  * Permission for MLflow experiment resources (order: weakest to strongest) */
export type ExperimentPermission = "CAN_READ" | "CAN_EDIT" | "CAN_MANAGE";
/**  * Permission for Databricks App resources */
export type AppPermission = "CAN_USE";

/**
 * Schema for Databricks AppKit plugin manifest files. Defines plugin metadata, resource requirements, and configuration options.
 */
export interface PluginManifest {
  /**
   * Reference to the JSON Schema for validation
   */
  $schema?: string;
  /**
   * Plugin identifier. Must be lowercase, start with a letter, and contain only letters, numbers, and hyphens.
   */
  name: string;
  /**
   * Human-readable display name for UI and CLI
   */
  displayName: string;
  /**
   * Brief description of what the plugin does
   */
  description: string;
  /**
   * Databricks resource requirements for this plugin
   */
  resources: {
    /**
     * Resources that must be available for the plugin to function
     */
    required: ResourceRequirement[];
    /**
     * Resources that enhance functionality but are not mandatory
     */
    optional: ResourceRequirement[];
  };
  /**
   * Configuration schema for the plugin
   */
  config?: {
    schema?: ConfigSchema;
  };
  /**
   * Author name or organization
   */
  author?: string;
  /**
   * Plugin version (semver format)
   */
  version?: string;
  /**
   * URL to the plugin's source repository
   */
  repository?: string;
  /**
   * Keywords for plugin discovery
   */
  keywords?: string[];
  /**
   * SPDX license identifier
   */
  license?: string;
  /**
   * Message displayed to the user after project initialization. Use this to inform about manual setup steps (e.g. environment variables, resource provisioning).
   */
  onSetupMessage?: string;
  /**
   * When true, this plugin is excluded from the template plugins manifest (appkit.plugins.json) during sync.
   */
  hidden?: boolean;
}
export interface ResourceFieldEntry {
  /**
   * Environment variable name for this field
   */
  env?: string;
  /**
   * Human-readable description for this field
   */
  description?: string;
  /**
   * When true, this field is excluded from Databricks bundle configuration (databricks.yml) generation.
   */
  bundleIgnore?: boolean;
  /**
   * Example values showing the expected format for this field
   */
  examples?: string[];
  /**
   * When true, this field is only generated for local .env files. The Databricks Apps platform auto-injects it at deploy time.
   */
  localOnly?: boolean;
  /**
   * Static value for this field. Used when no prompted or resolved value exists.
   */
  value?: string;
  /**
   * Named resolver prefixed by resource type (e.g., 'postgres:host'). The CLI resolves this value during the init prompt flow.
   */
  resolve?: string;
}
export interface ConfigSchema {
  type: "object" | "array" | "string" | "number" | "boolean";
  properties?: {
    [k: string]: ConfigSchemaProperty;
  };
  items?: ConfigSchema;
  required?: string[];
  additionalProperties?: boolean;
}
export interface ConfigSchemaProperty {
  type: "object" | "array" | "string" | "number" | "boolean" | "integer";
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: {
    [k: string]: ConfigSchemaProperty;
  };
  items?: ConfigSchemaProperty;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  required?: string[];
}
