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
    const timeoutId = setTimeout(() => {
      timeoutController.abort(
        new Error(`Operation timed out after ${this.timeoutMs} ms`),
      );
    }, this.timeoutMs);

    try {
      // combine user signal (if exists) with timeout signal
      const combinedSignal = context.signal
        ? this._combineSignals([context.signal, timeoutController.signal])
        : timeoutController.signal;

      // execute function with combined signal
      context.signal = combinedSignal;
      return await fn();
    } finally {
      // cleanup timeout
      clearTimeout(timeoutId);
    }
  }

  private _combineSignals(signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener(
        "abort",
        () => {
          controller.abort(signal.reason);
        },
        { once: true },
      );
    }
    return controller.signal;
  }
}
