import type { AbortConfig } from "./abort";
import type { CacheConfig } from "./cache";

export interface ExecuteOptions {
  cache?: CacheConfig;
  abort?: AbortConfig;
  [key: string]: unknown;
}
