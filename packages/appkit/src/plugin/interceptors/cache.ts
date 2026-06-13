import type { CacheConfig } from "shared";
import type { CacheManager } from "../../cache";
import type { ExecutionInterceptor, InterceptorContext } from "./types";

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

    const callerSignal = context.signal;

    // The cache may dedupe this request onto a shared in-flight execution.
    // Swap context.signal to the cache-owned shared signal for the duration
    // of fn() so the inner interceptor chain (timeout/retry/telemetry) and
    // the underlying I/O observe abort only when *all* callers have left,
    // not just this one. Without this swap, mount #1's abort under React
    // StrictMode poisons mount #2's joined inflight result.
    return this.cacheManager.getOrExecute(
      this.config.cacheKey,
      async (sharedSignal) => {
        const previousSignal = context.signal;
        context.signal = sharedSignal;
        try {
          return await fn();
        } finally {
          context.signal = previousSignal;
        }
      },
      context.userKey,
      { ttl: this.config.ttl, callerSignal },
    );
  }
}
