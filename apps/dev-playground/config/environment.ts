import { createEnv } from "@databricks/appkit";
import { z } from "zod";

export const env = createEnv({
  server: z.object({
    DATABRICKS_GENIE_SPACE_ID: z.string().optional().default("placeholder"),
    DATABRICKS_CONFIG_PROFILE: z.string().optional().default("DEFAULT"),
    DATABRICKS_WAREHOUSE_ID: z.string(),
    DATABRICKS_APP_PORT: z.number(),
    DATABRICKS_HOST: z.httpUrl(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.httpUrl(),
    OTEL_RESOURCE_ATTRIBUTES: z.string(),
    OTEL_SERVICE_NAME: z.string(),
    DATABRICKS_VOLUME_PLAYGROUND: z.string(),
    DATABRICKS_VOLUME_OTHER: z.string(),
  }),
  client: z.object({}),
});
