import type { PluginExecuteConfig } from "shared";

export const aiFunctionsDefaults: PluginExecuteConfig = {
  cache: { enabled: false },
  // AI Functions calls are idempotent. Only 429 and 503 are retryable
  // (see AiFunctionsRequestError), so other failures still fail fast.
  retry: { enabled: true, attempts: 3, initialDelay: 1000, maxDelay: 10_000 },
  timeout: 60_000,
};
