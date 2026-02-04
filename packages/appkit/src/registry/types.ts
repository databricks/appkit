/**
 * Resource Registry Type System
 *
 * This module defines the type system for the AppKit Resource Registry,
 * which enables plugins to declare their Databricks resource requirements
 * in a machine-readable format.
 */

/**
 * Supported resource types that plugins can depend on.
 */
export enum ResourceType {
  /** Databricks SQL Warehouse for query execution */
  SQL_WAREHOUSE = "sql-warehouse",

  /** Lakebase instance for persistent caching or data storage */
  LAKEBASE = "lakebase",

  /** Databricks Job for scheduled or triggered workflows */
  JOB = "job",

  /** Secret scope for secure credential storage */
  SECRET_SCOPE = "secret-scope",

  /** Model serving endpoint for ML inference */
  SERVING_ENDPOINT = "serving-endpoint",

  /** Vector search index for similarity search */
  VECTOR_SEARCH_INDEX = "vector-search-index",

  /** Unity Catalog for data governance and metadata */
  UNITY_CATALOG = "unity-catalog",
}

/**
 * Permission levels that can be required for a resource.
 * Based on Databricks permission model.
 */
export type ResourcePermission =
  | "CAN_USE"
  | "CAN_MANAGE"
  | "CAN_VIEW"
  | "READ"
  | "WRITE"
  | "EXECUTE";

/**
 * Declares a resource requirement for a plugin.
 * Can be defined statically in a manifest or dynamically via getResourceRequirements().
 */
export interface ResourceRequirement {
  /** Type of Databricks resource required */
  type: ResourceType;

  /** Unique alias for this resource within the plugin (e.g., 'warehouse', 'secrets') */
  alias: string;

  /** Human-readable description of why this resource is needed */
  description: string;

  /** Required permission level for the resource */
  permission: ResourcePermission;

  /**
   * Environment variable name where the resource ID/value should be provided
   * Example: 'DATABRICKS_WAREHOUSE_ID', 'DATABRICKS_SECRET_SCOPE'
   */
  env?: string;

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

  /** Whether the resource has been resolved (environment variable found) */
  resolved: boolean;

  /** The actual value of the resource (if resolved) */
  value?: string;
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

/**
 * Configuration schema definition for plugin config.
 * Uses JSON Schema format for validation and documentation.
 */
export interface ConfigSchema {
  type: "object" | "array" | "string" | "number" | "boolean";
  properties?: Record<string, ConfigSchemaProperty>;
  items?: ConfigSchema;
  required?: string[];
  additionalProperties?: boolean;
  /** Allow additional JSON Schema properties */
  [key: string]: unknown;
}

/**
 * Individual property definition in a config schema.
 */
export interface ConfigSchemaProperty {
  type: "object" | "array" | "string" | "number" | "boolean";
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, ConfigSchemaProperty>;
  items?: ConfigSchemaProperty;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

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
