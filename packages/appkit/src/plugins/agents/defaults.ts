import type { StreamExecutionSettings } from "shared";

export const agentStreamDefaults: StreamExecutionSettings = {
  default: {
    cache: { enabled: false },
    retry: { enabled: false },
    timeout: 300_000,
  },
  stream: {
    bufferSize: 200,
  },
};
