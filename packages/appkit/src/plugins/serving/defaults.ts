import type { StreamExecutionSettings } from "shared";

export const servingInvokeDefaults = {
  cache: {
    enabled: false,
  },
  retry: {
    enabled: false,
  },
  timeout: 120_000,
};

export const servingStreamDefaults: StreamExecutionSettings = {
  default: {
    cache: {
      enabled: false,
    },
    retry: {
      enabled: false,
    },
    timeout: 120_000,
  },
  stream: {
    bufferSize: 200,
  },
};
