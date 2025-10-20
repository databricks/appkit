import type { RetryConfig } from "@databricks-apps/types";
import type { ExecutionContext, ExecutionInterceptor } from "./types";

// interceptor to handle retry logic
export class RetryInterceptor implements ExecutionInterceptor {
  private attempts: number;
  private initialDelay: number;
  private maxDelay: number;

  constructor(config: RetryConfig) {
    this.attempts = config.attempts ?? 3;
    this.initialDelay = config.initialDelay ?? 1000;
    this.maxDelay = config.maxDelay ?? 30000;
  }

  async intercept<T>(
    fn: () => Promise<T>,
    context: ExecutionContext,
  ): Promise<T> {
    let lastError: Error | unknown;

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // last attempt, rethrow the error
        if (attempt === this.attempts) {
          throw error;
        }

        // don't retry if was already aborted
        if (context.signal?.aborted) {
          throw error;
        }

        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }

    // type guard
    throw lastError;
  }

  private calculateDelay(attempt: number): number {
    // exponential backoff
    const delay = this.initialDelay * 2 ** (attempt - 1);

    // max delay cap
    return Math.min(delay, this.maxDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
