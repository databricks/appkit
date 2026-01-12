import { createDebug } from "../../observability/debug";
import type { ILogger } from "../../observability";
import type { ExecutionContext, ExecutionInterceptor } from "./types";

const debug = createDebug("observability-interceptor");

/**
 * Interceptor to automatically instrument plugin executions with observability spans.
 * Wraps the execution in a span and handles success/error status.
 */
export class ObservabilityInterceptor implements ExecutionInterceptor {
  constructor(private logger: ILogger) {}

  async intercept<T>(
    fn: () => Promise<T>,
    context: ExecutionContext,
  ): Promise<T> {
    // Derive span name from context
    const spanName = context.operation
      ? `${context.pluginName}.${context.operation}`
      : `${context.pluginName}.execute`;

    debug("Creating span: %s", spanName);

    return this.logger.span(spanName, async () => {
      return await fn();
    });
  }
}
