import type { StreamExecutionSettings } from "shared";

export const multiGenieStreamDefaults: StreamExecutionSettings = {
  default: {
    cache: { enabled: false },
    retry: { enabled: false },
    timeout: 300_000,
  },
};
