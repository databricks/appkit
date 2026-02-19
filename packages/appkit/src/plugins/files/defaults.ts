import type { PluginExecuteConfig } from "shared";

export const filesReadDefaults: PluginExecuteConfig = {
  cache: {
    enabled: true,
    ttl: 60_000,
  },
  retry: {
    enabled: true,
    initialDelay: 1000,
    attempts: 3,
  },
  timeout: 30_000,
};

export const filesDownloadDefaults: PluginExecuteConfig = {
  cache: {
    enabled: false,
  },
  retry: {
    enabled: true,
    initialDelay: 1000,
    attempts: 3,
  },
  /**
   * @info this timeout is for the stream to start, not for the full download.
   */
  timeout: 30_000,
};

export const filesWriteDefaults: PluginExecuteConfig = {
  cache: {
    enabled: false,
  },
  retry: {
    enabled: false,
  },
  timeout: 600_000,
};

export { EXTENSION_CONTENT_TYPES } from "../../connectors/files/defaults";
