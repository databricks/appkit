import type { ITelemetry, Span } from "../../telemetry";
import { SpanStatusCode } from "../../telemetry";
import type { TelemetryConfig } from "shared";
import type { InterceptorContext, ExecutionInterceptor } from "./types";

/**
 * Interceptor to automatically instrument plugin executions with telemetry spans.
 * Wraps the execution in a span and handles success/error status.
 */
export class TelemetryInterceptor implements ExecutionInterceptor {
  constructor(
    private telemetry: ITelemetry,
    private config?: TelemetryConfig,
  ) {}

  async intercept<T>(
    fn: () => Promise<T>,
    _context: InterceptorContext,
  ): Promise<T> {
    const spanName = this.config?.spanName || "plugin.execute";
    return this.telemetry.startActiveSpan(
      spanName,
      { attributes: this.config?.attributes },
      async (span: Span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
