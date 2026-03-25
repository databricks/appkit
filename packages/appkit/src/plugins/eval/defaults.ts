import type { PluginExecuteConfig } from "shared";

/** Default execution config for eval volume I/O. */
export const evalVolumeDefaults: PluginExecuteConfig = {
  cache: {
    enabled: false,
  },
  retry: {
    enabled: true,
    attempts: 3,
    initialDelay: 1000,
  },
  timeout: 60000,
};

/** Default apps volume path. */
export const DEFAULT_APPS_VOLUME = "/Volumes/main/default/apps_mcp_generated";

/** Default MLflow experiment. */
export const DEFAULT_MLFLOW_EXPERIMENT = "/Shared/apps-mcp-evaluations";
