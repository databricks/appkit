import { AbortConfig } from "./abort";
import { CacheConfig } from "./cache";

export interface ExecuteOptions {
  cache?: CacheConfig;
  abort?: AbortConfig;
}

