import type { PluginExecuteConfig } from "shared";

/**
 * Execution defaults for read-tier operations (list, read, exists, metadata, preview).
 * Cache 60s (ttl in seconds)
 * Retry 3x with 1s backoff
 * Timeout 30s
 **/
export const FILES_READ_DEFAULTS: PluginExecuteConfig = {
  cache: {
    enabled: true,
    ttl: 60,
  },
  retry: {
    enabled: true,
    initialDelay: 1000,
    attempts: 3,
  },
  timeout: 30_000,
};

/**
 * Execution defaults for download-tier operations (download, raw).
 * No cache
 * Retry 3x with 1s backoff
 * Timeout 30s (stream start only)
 **/
export const FILES_DOWNLOAD_DEFAULTS: PluginExecuteConfig = {
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

/**
 * Execution defaults for write-tier operations (upload, mkdir, delete).
 * No cache
 * No retry
 * Timeout 600s.
 **/
export const FILES_WRITE_DEFAULTS: PluginExecuteConfig = {
  cache: {
    enabled: false,
  },
  retry: {
    enabled: false,
  },
  timeout: 600_000,
};

export { EXTENSION_CONTENT_TYPES } from "../../connectors/files/defaults";
