import type { CacheConfig } from "./cache";

/** SSE stream configuration for `executeStream()`. Controls buffer sizes, heartbeat interval, and cleanup behavior. */
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

/** Retry configuration for the RetryInterceptor. Uses exponential backoff with full jitter between attempts. */
export interface RetryConfig {
  enabled?: boolean;
  attempts?: number;
  initialDelay?: number;
  maxDelay?: number;
}

/** Telemetry configuration for the TelemetryInterceptor. Controls span creation and custom attributes. */
export interface TelemetryConfig {
  enabled?: boolean;
  spanName?: string;
  attributes?: Record<string, any>;
}

/** Options passed to `Plugin.execute()` and `Plugin.executeStream()` to configure the interceptor chain (cache, retry, telemetry, timeout). */
export interface PluginExecuteConfig {
  cache?: CacheConfig;
  retry?: RetryConfig;
  // to not mix with the 'telemetry' plugin config property - it is a different thing
  telemetryInterceptor?: TelemetryConfig;
  abort?: AbortSignal;
  timeout?: number;
  [key: string]: unknown;
}

/** Default and user-scoped execution settings for a plugin. The `user` config, when present, overrides `default` for on-behalf-of requests. */
export interface PluginExecutionSettings {
  default: PluginExecuteConfig;
  user?: PluginExecuteConfig;
}

/** Handler function for `executeStream()`. Can return a Promise (single result) or an AsyncGenerator (chunked streaming). */
export type StreamExecuteHandler<T> =
  | ((signal?: AbortSignal) => Promise<T>)
  | ((signal?: AbortSignal) => AsyncGenerator<T, void, unknown>);

/** Execution settings for streaming endpoints. Extends PluginExecutionSettings with SSE stream configuration. */
export interface StreamExecutionSettings {
  default: PluginExecuteConfig;
  user?: PluginExecuteConfig;
  stream?: StreamConfig;
}
