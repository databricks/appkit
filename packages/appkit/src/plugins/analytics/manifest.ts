import type { PluginManifest } from "../../registry";
import { ResourceType } from "../../registry";

/**
 * Analytics plugin manifest.
 *
 * The analytics plugin requires a SQL Warehouse for executing queries
 * against Databricks data sources.
 */
export const analyticsManifest: PluginManifest = {
  name: "analytics",
  displayName: "Analytics Plugin",
  description: "SQL query execution against Databricks SQL Warehouses",

  resources: {
    required: [
      {
        type: ResourceType.SQL_WAREHOUSE,
        alias: "warehouse",
        description: "SQL Warehouse for executing analytics queries",
        permission: "CAN_USE",
        env: "DATABRICKS_WAREHOUSE_ID",
      },
    ],
    optional: [],
  },

  config: {
    schema: {
      type: "object",
      properties: {
        timeout: {
          type: "number",
          default: 30000,
          description: "Query execution timeout in milliseconds",
        },
        queriesDir: {
          type: "string",
          description: "Directory containing SQL query files",
        },
        cacheEnabled: {
          type: "boolean",
          default: true,
          description: "Enable query result caching",
        },
      },
    },
  },
};
