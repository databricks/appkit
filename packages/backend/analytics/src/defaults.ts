import type { ExecuteOptions } from "@databricks-apps/types";

export const queryDefaults: ExecuteOptions = {
  cache: {
    enabled: true,
    ttl: 3600,
  },
  retry: {
    enabled: true,
    initialDelay: 1500,
    attempts: 3,
  },
  timeout: 18000,
};
