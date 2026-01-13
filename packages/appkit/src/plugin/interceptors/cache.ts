import type { CacheConfig } from "shared";
import type { CacheManager } from "../../cache";
import { createLogger } from "../../logging/logger";
import type { ExecutionInterceptor, InterceptorContext } from "./types";

const logger = createLogger("interceptors:cache");

// interceptor to handle caching logic
export class CacheInterceptor implements ExecutionInterceptor {
  constructor(
    private cacheManager: CacheManager,
    private config: CacheConfig,
  ) {}

  async intercept<T>(
    fn: () => Promise<T>,
    context: InterceptorContext,
  ): Promise<T> {
    // if cache disabled, ignore
    if (!this.config.enabled || !this.config.cacheKey?.length) {
      return fn();
    }

    // get wide event from request if available
    const wideEvent = context.request ? logger.event(context.request) : null;

    return this.cacheManager.getOrExecute(
      this.config.cacheKey,
      fn,
      context.userKey,
      { ttl: this.config.ttl },
      wideEvent,
    );
  }
}
