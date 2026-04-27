import type { RetryConfig } from "shared";
import { AppKitError } from "../../errors/base";
import { createLogger } from "../../logging/logger";
import type { ExecutionInterceptor, InterceptorContext } from "./types";

const logger = createLogger("interceptors:retry");

/**
 * Determines whether an error is safe to retry.
 *
 * Priority:
 *  1. AppKitError — reads the `isRetryable` boolean property.
 *  2. Databricks SDK ApiError (duck-typed) — calls `isRetryable()` method,
 *     or falls back to status-code heuristic (5xx / 429 → retryable).
 *  3. Unknown errors — treated as retryable to preserve backward compatibility.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof AppKitError) {
    return error.isRetryable;
  }

  if (error instanceof Error && "statusCode" in error) {
    const record = error as Record<string, unknown>;
    if (typeof record.statusCode !== "number") {
      return true;
    }
    if (typeof record.isRetryable === "function") {
      return (record.isRetryable as () => boolean)();
    }
    return record.statusCode >= 500 || record.statusCode === 429;
  }

  return true;
}

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
    context: InterceptorContext,
  ): Promise<T> {
    let lastError: Error | unknown;

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const result = await fn();

        if (attempt > 1) {
          logger.event()?.setExecution({
            retry_attempts: attempt - 1,
          });
        }

        return result;
      } catch (error) {
        lastError = error;

        if (attempt === this.attempts) {
          logger.event()?.setExecution({
            retry_attempts: attempt - 1,
          });
          throw error;
        }

        if (context.signal?.aborted) {
          throw error;
        }

        if (!isRetryableError(error)) {
          throw error;
        }

        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private calculateDelay(attempt: number): number {
    const delay = this.initialDelay * 2 ** (attempt - 1);
    const capped = Math.min(delay, this.maxDelay);

    return capped * Math.random();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
