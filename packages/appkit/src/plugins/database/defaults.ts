import type { PluginExecuteConfig } from "shared";

/** Default interceptor policy for bounded reads. */
export const databaseReadDefaults: PluginExecuteConfig = {
  retry: { enabled: false },
};

/** Default interceptor policy for mutations. */
export const databaseWriteDefaults: PluginExecuteConfig = {
  cache: { enabled: false },
  retry: { enabled: false },
};
