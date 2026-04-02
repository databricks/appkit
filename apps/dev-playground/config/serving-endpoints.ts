import type { EndpointConfig } from "@databricks/appkit";

export const servingEndpoints = {
  demo: { env: "DATABRICKS_SERVING_ENDPOINT" },
  second: { env: "DATABRICKS_SERVING_ENDPOINT_SECOND" },
  third: { env: "DATABRICKS_SERVING_ENDPOINT_THIRD" },
} as const satisfies Record<string, EndpointConfig>;
