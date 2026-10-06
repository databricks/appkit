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

    // Latch the first cancellation eagerly, even if the operation never
    // listens to the signal. Unobserved AbortSignal.any() composites can
    // resolve lazily in Node and choose source order instead of abort order.
    const executionController = new AbortController();
    const callerSignal = context.signal;
    const onCallerAbort = () => executionController.abort(callerSignal?.reason);
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const timeoutError = new ExecutionTimeoutError(this.timeoutMs);
    const timeoutId = setTimeout(() => {
      executionController.abort(timeoutError);
    }, this.timeoutMs);
    const combinedSignal = executionController.signal;

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
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
