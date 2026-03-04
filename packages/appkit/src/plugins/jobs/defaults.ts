import type { StreamExecutionSettings } from "shared";

export const jobsStreamDefaults: StreamExecutionSettings = {
  default: {
    // Cache disabled: job runs are stateful operations, not repeatable queries.
    cache: {
      enabled: false,
    },
    // Retry disabled: runNow is not idempotent (retries could trigger duplicate runs).
    retry: {
      enabled: false,
    },
    timeout: 600_000,
  },
  stream: {
    bufferSize: 100,
  },
};
