/**
 * Resource types and permissions sourced from the canonical Zod schemas in
 * `schemas/manifest.ts`. Single source of truth so create, add-resource, and
 * validate stay in sync with the schema.
 *
 * Values are constant at module load (direct Zod imports, no runtime JSON-schema
 * read), so no caching is needed.
 */
import {
  appPermissionSchema,
  databasePermissionSchema,
  experimentPermissionSchema,
  genieSpacePermissionSchema,
  jobPermissionSchema,
  postgresPermissionSchema,
  resourceTypeSchema,
  secretPermissionSchema,
  servingEndpointPermissionSchema,
  sqlWarehousePermissionSchema,
  ucConnectionPermissionSchema,
  ucFunctionPermissionSchema,
  vectorSearchIndexPermissionSchema,
  volumePermissionSchema,
} from "../../../schemas/manifest";

export interface ResourceTypeOption {
  value: string;
  label: string;
}

/** Optional display overrides for acronyms (e.g. SQL, UC). Omitted entries use title-case of value. */
const LABEL_OVERRIDES: Record<string, string> = {
  sql_warehouse: "SQL Warehouse",
  uc_function: "UC Function",
  uc_connection: "UC Connection",
};

function humanize(value: string): string {
  if (LABEL_OVERRIDES[value]) return LABEL_OVERRIDES[value];
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Map from resource type literal to its permission enum schema. Mirrors the
 * `allOf + if/then` block in the previous hand-written JSON Schema, but driven
 * directly from the Zod source. Add an entry here when extending
 * `resourceTypeSchema`.
 */
const PERMISSION_SCHEMAS_BY_TYPE = {
  secret: secretPermissionSchema,
  job: jobPermissionSchema,
  sql_warehouse: sqlWarehousePermissionSchema,
  serving_endpoint: servingEndpointPermissionSchema,
  volume: volumePermissionSchema,
  vector_search_index: vectorSearchIndexPermissionSchema,
  uc_function: ucFunctionPermissionSchema,
  uc_connection: ucConnectionPermissionSchema,
  database: databasePermissionSchema,
  postgres: postgresPermissionSchema,
  genie_space: genieSpacePermissionSchema,
  experiment: experimentPermissionSchema,
  app: appPermissionSchema,
} as const;

/**
 * Resource type options (value + label) from `resourceTypeSchema.options`.
 */
export function getResourceTypeOptions(): ResourceTypeOption[] {
  return resourceTypeSchema.options.map((value) => ({
    value,
    label: humanize(value),
  }));
}

/**
 * Permissions per resource type, derived from each type's per-type permission
 * schema's `.options` array. Order is weakest-to-strongest (matches Zod enum
 * declaration order, which the original JSON Schema also preserved).
 */
export function getResourceTypePermissions(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [type, schema] of Object.entries(PERMISSION_SCHEMAS_BY_TYPE)) {
    out[type] = [...schema.options];
  }
  return out;
}
