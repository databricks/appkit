import { ExecutionTimeoutError } from "../../errors/timeout";
import { createLogger } from "../../logging/logger";
import type { ExecutionInterceptor, InterceptorContext } from "./types";

const logger = createLogger("interceptors:timeout");

// interceptor to handle timeout logic
export class TimeoutInterceptor implements ExecutionInterceptor {
  constructor(private timeoutMs: number) {}

  async intercept<T>(
    fn: () => Promise<T>,
    context: InterceptorContext,
  ): Promise<T> {
    logger.event()?.setExecution({
      timeout_ms: this.timeoutMs,
    });

    // create timeout signal
    const timeoutController = new AbortController();
    const timeoutError = new ExecutionTimeoutError(this.timeoutMs);
    const timeoutId = setTimeout(() => {
      timeoutController.abort(timeoutError);
    }, this.timeoutMs);

    const combinedSignal = context.signal
      ? AbortSignal.any([context.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      // execute function with combined signal
      context.signal = combinedSignal;
      return await fn();
    } catch (error) {
      // The SDK replaces the signal reason with a generic AbortError. Check
      // the winning reason, not just whether our timer eventually fired.
      if (combinedSignal.reason === timeoutError) {
        throw new ExecutionTimeoutError(
          this.timeoutMs,
          error instanceof Error ? error : undefined,
        );
      }
      throw error;
    } finally {
      // cleanup timeout
      clearTimeout(timeoutId);
    }
  }
}
