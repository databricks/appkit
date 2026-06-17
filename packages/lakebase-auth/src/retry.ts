import type { LogFn } from "./types";

/** Default retry schedule: one retry after each delay, then a final attempt. */
export const DEFAULT_RETRY_SCHEDULE = [50, 500, 5000];

/**
 * Wrap an async function with basic retry logic.
 *
 * On each failure the function is retried after the next delay in `schedule`.
 * Once the schedule is exhausted, one final attempt is made and its result
 * (or error) is returned — rethrowing the original rather than a wrapped error
 * preserves the stack trace. An empty `schedule` disables retries.
 *
 * @param fn The async function to execute
 * @param schedule Delays (ms) between retry attempts
 * @param onLog Optional structured logging callback for retry warnings
 * @returns A function with the same signature that applies the retry policy
 */
export function withRetries<T>(
  fn: () => Promise<T>,
  schedule: number[] = DEFAULT_RETRY_SCHEDULE,
  onLog?: LogFn,
): () => Promise<T> {
  return async function retrying(): Promise<T> {
    for (const retryDelay of schedule) {
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onLog?.(
          "warn",
          "Retrying credential fetch in %dms after error: %s",
          retryDelay,
          message,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
    // Final attempt: call again rather than rethrowing to preserve stack trace.
    return await fn();
  };
}
