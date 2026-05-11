import type { PluginExecuteConfig } from "shared";

/**
 * Execution defaults for read-tier operations (getRun, getJob, listRuns, lastRun, getRunOutput).
 * Cache 60s (ttl in seconds)
 * Retry 3x with 1s backoff
 * Timeout 30s
 */
export const JOBS_READ_DEFAULTS: PluginExecuteConfig = {
  cache: { enabled: true, ttl: 60 },
  retry: { enabled: true, initialDelay: 1000, attempts: 3 },
  timeout: 30_000,
};

/**
 * Execution defaults for write-tier operations (runNow, cancelRun).
 * No cache
 * No retry
 * Timeout 120s
 */
export const JOBS_WRITE_DEFAULTS: PluginExecuteConfig = {
  cache: { enabled: false },
  retry: { enabled: false },
  timeout: 120_000,
};

/**
 * Execution defaults for stream-tier operations (runNowAndWait with polling).
 * No cache
 * No retry
 * Timeout 600s
 */
export const JOBS_STREAM_DEFAULTS: PluginExecuteConfig = {
  cache: { enabled: false },
  retry: { enabled: false },
  timeout: 600_000,
};
