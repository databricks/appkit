/**
 * Resource type and permission defaults for plugin scaffolding.
 * Values are derived from plugin-manifest.schema.json via schema-resources.
 */

import {
  getResourceTypeOptions,
  getResourceTypePermissions,
  type ResourceTypeOption,
} from "../schema-resources";

export const MANIFEST_SCHEMA_ID =
  "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json";

export type { ResourceTypeOption };

/** Resource types from schema resourceType enum (value, human label). */
export const RESOURCE_TYPE_OPTIONS: ResourceTypeOption[] =
  getResourceTypeOptions();

/** All valid permissions per resource type, from schema allOf/if-then rules. */
export const PERMISSIONS_BY_TYPE: Record<string, string[]> =
  getResourceTypePermissions();

/** Default (first) permission per resource type for scaffolding. */
export const DEFAULT_PERMISSION_BY_TYPE: Record<string, string> =
  Object.fromEntries(
    Object.entries(PERMISSIONS_BY_TYPE).map(([type, perms]) => [
      type,
      perms[0],
    ]),
  );

/** Default fields per resource type: field key -> { env, description }. */
export const DEFAULT_FIELDS_BY_TYPE: Record<
  string,
  Record<string, { env: string; description?: string }>
> = {
  sql_warehouse: {
    id: { env: "DATABRICKS_WAREHOUSE_ID", description: "SQL Warehouse ID" },
  },
  secret: {
    scope: { env: "SECRET_SCOPE", description: "Secret scope name" },
    key: { env: "SECRET_KEY", description: "Secret key" },
  },
  job: {
    id: { env: "DATABRICKS_JOB_ID", description: "Job ID" },
  },
  serving_endpoint: {
    id: {
      env: "DATABRICKS_SERVING_ENDPOINT_ID",
      description: "Serving endpoint ID",
    },
  },
  volume: {
    name: { env: "VOLUME_NAME", description: "Volume name" },
  },
  vector_search_index: {
    endpoint_name: {
      env: "VECTOR_SEARCH_ENDPOINT_NAME",
      description: "Vector search endpoint name",
    },
    index_name: {
      env: "VECTOR_SEARCH_INDEX_NAME",
      description: "Vector search index name",
    },
  },
  uc_function: {
    name: {
      env: "UC_FUNCTION_NAME",
      description: "Unity Catalog function name",
    },
  },
  uc_connection: {
    name: {
      env: "UC_CONNECTION_NAME",
      description: "Unity Catalog connection name",
    },
  },
  database: {
    instance_name: {
      env: "DATABRICKS_INSTANCE_NAME",
      description: "Databricks instance name",
    },
    database_name: {
      env: "DATABASE_NAME",
      description: "Database name",
    },
  },
  genie_space: {
    id: { env: "GENIE_SPACE_ID", description: "Genie Space ID" },
  },
  experiment: {
    id: { env: "MLFLOW_EXPERIMENT_ID", description: "MLflow experiment ID" },
  },
  app: {
    id: { env: "DATABRICKS_APP_ID", description: "Databricks App ID" },
  },
};

/** Valid resource type values from the schema. */
export function getValidResourceTypes(): string[] {
  return RESOURCE_TYPE_OPTIONS.map((o) => o.value);
}

/** Humanized alias from resource type (e.g. sql_warehouse -> "SQL Warehouse"). */
export function humanizeResourceType(type: string): string {
  const option = RESOURCE_TYPE_OPTIONS.find((o) => o.value === type);
  return option ? option.label : type.replace(/_/g, " ");
}

/** Kebab-case resource key from type (e.g. sql_warehouse -> "sql-warehouse"). */
export function resourceKeyFromType(type: string): string {
  return type.replace(/_/g, "-");
}

/** Get default fields for a resource type; fallback to single id field. */
export function getDefaultFieldsForType(
  type: string,
): Record<string, { env: string; description?: string }> {
  const known = DEFAULT_FIELDS_BY_TYPE[type];
  if (known) return known;
  const key = resourceKeyFromType(type);
  const envName = `DATABRICKS_${key.toUpperCase().replace(/-/g, "_")}_ID`;
  return {
    id: { env: envName, description: `${humanizeResourceType(type)} ID` },
  };
}
