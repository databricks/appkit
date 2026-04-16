import type { PluginExecuteConfig } from "shared";

export const vectorSearchDefaults: PluginExecuteConfig = {
  cache: { enabled: false },
  retry: { enabled: true, initialDelay: 1000, attempts: 3 },
  timeout: 30_000,
};
