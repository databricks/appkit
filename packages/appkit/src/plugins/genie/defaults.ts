import type { StreamExecutionSettings } from "shared";

export const genieStreamDefaults: StreamExecutionSettings = {
  default: {
    // Cache disabled: chat messages are conversational and stateful, not repeatable queries.
    cache: {
      enabled: false,
    },
    // Retry disabled: Genie calls are not idempotent (retries could create duplicate
    // conversations/messages), and the SDK Waiter already handles transient polling failures.
    retry: {
      enabled: false,
    },
    timeout: 120_000,
  },
  stream: {
    bufferSize: 100,
  },
};
