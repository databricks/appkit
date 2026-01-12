import type { CacheConfig } from "./cache";
import type { ObservabilityOptions } from "./plugin";

export interface StreamConfig {
  userSignal?: AbortSignal;
  streamId?: string;
  bufferSize?: number;
  maxEventSize?: number;
  bufferTTL?: number;
  cleanupInterval?: number;
  maxPersistentBuffers?: number;
  heartbeatInterval?: number;
  maxActiveStreams?: number;
}

export interface RetryConfig {
  enabled?: boolean;
  attempts?: number;
  initialDelay?: number;
  maxDelay?: number;
}

export interface PluginExecuteConfig {
  cache?: CacheConfig;
  retry?: RetryConfig;
  observability?: ObservabilityOptions;
  abort?: AbortSignal;
  timeout?: number;
  [key: string]: unknown;
}

export interface PluginExecutionSettings {
  default: PluginExecuteConfig;
  user?: PluginExecuteConfig;
}

// stream execute handler can be a promise or a generator
export type StreamExecuteHandler<T> =
  | ((signal?: AbortSignal) => Promise<T>)
  | ((signal?: AbortSignal) => AsyncGenerator<T, void, unknown>);

export interface StreamExecutionSettings {
  default: PluginExecuteConfig;
  user?: PluginExecuteConfig;
  stream?: StreamConfig;
}
