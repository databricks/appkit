// AUTO-GENERATED from packages/shared/src/schemas/plugin-manifest.schema.json
// Do not edit. Run: pnpm exec tsx tools/generate-registry-types.ts

/** Resource types from schema $defs.resourceType.enum */
export enum ResourceType {
  SECRET = "secret",
  JOB = "job",
  SQL_WAREHOUSE = "sql_warehouse",
  SERVING_ENDPOINT = "serving_endpoint",
  VOLUME = "volume",
  VECTOR_SEARCH_INDEX = "vector_search_index",
  UC_FUNCTION = "uc_function",
  UC_CONNECTION = "uc_connection",
  DATABASE = "database",
  GENIE_SPACE = "genie_space",
  EXPERIMENT = "experiment",
  APP = "app",
}

// ============================================================================
// Permissions per resource type (from schema permission $defs)
// ============================================================================
/** Permissions for SECRET resources */
export type SecretPermission = "READ" | "WRITE" | "MANAGE";

/** Permissions for JOB resources */
export type JobPermission = "CAN_VIEW" | "CAN_MANAGE_RUN" | "CAN_MANAGE";

/** Permissions for SQL_WAREHOUSE resources */
export type SqlWarehousePermission = "CAN_USE" | "CAN_MANAGE";

/** Permissions for SERVING_ENDPOINT resources */
export type ServingEndpointPermission = "CAN_VIEW" | "CAN_QUERY" | "CAN_MANAGE";

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
  | "CAN_VIEW"
  | "CAN_RUN"
  | "CAN_EDIT"
  | "CAN_MANAGE";

/** Permissions for EXPERIMENT resources */
export type ExperimentPermission = "CAN_READ" | "CAN_EDIT" | "CAN_MANAGE";

/** Permissions for APP resources */
export type AppPermission = "CAN_USE";

/** Union of all possible permission levels across all resource types. */
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

/** Permission hierarchy per resource type (weakest to strongest). Schema enum order. */
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
