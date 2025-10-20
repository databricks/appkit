import type { CacheConfig } from "./cache";

export interface RetryConfig {
  enabled?: boolean;
  attempts?: number;
  initialDelay?: number;
  maxDelay?: number;
}

export interface ExecuteOptions {
  cache?: CacheConfig;
  retry?: RetryConfig;
  abort?: AbortSignal;
  timeout?: number;
  [key: string]: unknown;
}
