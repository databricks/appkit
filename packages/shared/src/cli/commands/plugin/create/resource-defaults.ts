/**
 * Resource type and permission defaults for plugin scaffolding.
 * Aligned with plugin-manifest.schema.json $defs.
 */

export const MANIFEST_SCHEMA_ID =
  "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json";

export interface ResourceTypeOption {
  value: string;
  label: string;
}

/** Resource types from schema resourceType enum (value, human label). */
export const RESOURCE_TYPE_OPTIONS: ResourceTypeOption[] = [
  { value: "secret", label: "Secret" },
  { value: "job", label: "Job" },
  { value: "sql_warehouse", label: "SQL Warehouse" },
  { value: "serving_endpoint", label: "Serving Endpoint" },
  { value: "volume", label: "Volume" },
  { value: "vector_search_index", label: "Vector Search Index" },
  { value: "uc_function", label: "UC Function" },
  { value: "uc_connection", label: "UC Connection" },
  { value: "database", label: "Database" },
  { value: "genie_space", label: "Genie Space" },
  { value: "experiment", label: "Experiment" },
  { value: "app", label: "App" },
];

/** All valid permissions per resource type, aligned with the schema if/then rules. */
export const PERMISSIONS_BY_TYPE: Record<string, string[]> = {
  secret: ["READ", "WRITE", "MANAGE"],
  job: ["CAN_VIEW", "CAN_MANAGE_RUN", "CAN_MANAGE"],
  sql_warehouse: ["CAN_USE", "CAN_MANAGE"],
  serving_endpoint: ["CAN_QUERY", "CAN_VIEW", "CAN_MANAGE"],
  volume: ["READ_VOLUME", "WRITE_VOLUME"],
  vector_search_index: ["SELECT"],
  uc_function: ["EXECUTE"],
  uc_connection: ["USE_CONNECTION"],
  database: ["CAN_CONNECT_AND_CREATE"],
  genie_space: ["CAN_VIEW", "CAN_RUN", "CAN_EDIT", "CAN_MANAGE"],
  experiment: ["CAN_READ", "CAN_EDIT", "CAN_MANAGE"],
  app: ["CAN_USE"],
};

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
