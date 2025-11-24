import type { CacheManager } from "@databricks-apps/cache";
import type { CacheConfig } from "@databricks-apps/types";
import type { ExecutionContext, ExecutionInterceptor } from "./types";

// interceptor to handle caching logic
export class CacheInterceptor implements ExecutionInterceptor {
  constructor(
    private cacheManager: CacheManager,
    private config: CacheConfig,
  ) {}

  async intercept<T>(
    fn: () => Promise<T>,
    context: ExecutionContext,
  ): Promise<T> {
    // if cache disabled, ignore
    if (!this.config.enabled || !this.config.cacheKey?.length) {
      return fn();
    }

    return this.cacheManager.getOrExecute(
      this.config.cacheKey,
      fn,
      context.userKey,
      { ttl: this.config.ttl },
    );
  }
}
