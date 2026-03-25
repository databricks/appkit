import type { PluginExecuteConfig } from "shared";

/** Default execution config for gRPC calls. */
export const grpcCallDefaults: PluginExecuteConfig = {
  cache: {
    enabled: false,
  },
  retry: {
    enabled: true,
    attempts: 3,
    initialDelay: 500,
  },
  timeout: 30000,
};

/** Default execution config for Volume I/O operations. */
export const volumeIODefaults: PluginExecuteConfig = {
  cache: {
    enabled: false,
  },
  retry: {
    enabled: true,
    attempts: 2,
    initialDelay: 1000,
  },
  timeout: 60000,
};

/** Default max message size: 4MB */
export const DEFAULT_MAX_MESSAGE_SIZE = 4 * 1024 * 1024;

/** Default gRPC standalone port */
export const DEFAULT_GRPC_PORT = 50051;

/** Shutdown drain timeout in milliseconds */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
