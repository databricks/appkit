import type { PluginExecuteConfig } from "shared";

/** Execution defaults for read-tier operations (list, read, exists, metadata, preview). Cache 60 s, retry 3x with 1 s backoff, 30 s timeout. */
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

/** Execution defaults for download-tier operations (download, raw). No cache, retry 3x with 1 s backoff, 30 s timeout (stream start only). */
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

/** Execution defaults for write-tier operations (upload, mkdir, delete). No cache, no retry, 600 s timeout. */
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
