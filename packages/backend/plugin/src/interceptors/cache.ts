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

    // generate cache key and check cache
    const cacheKey = this.cacheManager.generateKey(
      this.config.cacheKey,
      context?.userToken,
    );
    const cached = this.cacheManager.get<T>(cacheKey);

    if (cached !== null) {
      return cached;
    }

    const result = await fn();

    // store in cache
    this.cacheManager.set(cacheKey, result, { ttl: this.config.ttl });

    return result;
  }
}
