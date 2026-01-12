import type { ILogger } from "../../observability";
import { createDebug } from "../../observability/debug";
import type { ExecutionInterceptor, InterceptorContext } from "./types";

const debug = createDebug("observability-interceptor");

/**
 * Interceptor to automatically instrument plugin executions with observability spans.
 * Wraps the execution in a span and handles success/error status.
 */
export class ObservabilityInterceptor implements ExecutionInterceptor {
  constructor(private logger: ILogger) {}

  async intercept<T>(
    fn: () => Promise<T>,
    context: InterceptorContext,
  ): Promise<T> {
    /**
     * Important: `Plugin` already constructs `this.logger` with scope = plugin name.
     * `Logger.span(name)` prefixes with `${scope}.${name}`.
     *
     * So we should pass only the *operation* here (e.g. "query"), not
     * `${pluginName}.${operation}`, otherwise we end up with "analytics.analytics.query".
     */
    const rawOperation = context.operation ?? "execute";
    const operation = rawOperation.startsWith(`${context.pluginName}.`)
      ? rawOperation.slice(context.pluginName.length + 1)
      : rawOperation;

    debug("Creating span: %s.%s", context.pluginName, operation);

    return this.logger.span(operation, async () => {
      return await fn();
    });
  }
}
