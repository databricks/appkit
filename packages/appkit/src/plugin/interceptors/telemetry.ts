import type { TelemetryConfig } from "shared";
import type { ITelemetry, Span } from "../../telemetry";
import { SpanStatusCode } from "../../telemetry";
import type { ExecutionInterceptor, InterceptorContext } from "./types";

export class TelemetryInterceptor implements ExecutionInterceptor {
  constructor(
    private telemetry: ITelemetry,
    private config?: TelemetryConfig,
  ) {}

  async intercept<T>(
    fn: () => Promise<T>,
    context: InterceptorContext,
  ): Promise<T> {
    const spanName = this.config?.spanName || "plugin.execute";

    // abort operation if signal is aborted
    if (context.signal?.aborted) {
      throw new Error("Operation aborted before execution");
    }

    return this.telemetry.startActiveSpan(
      spanName,
      { attributes: this.config?.attributes },
      async (span: Span) => {
        let abortHandler: (() => void) | undefined;
        let isAborted = false;

        if (context.signal) {
          abortHandler = () => {
            // abort span if not recording
            if (!span.isRecording()) return;
            isAborted = true;
            span.setAttribute("cancelled", true);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: "Operation cancelled by client",
            });
            span.end();
          };
          context.signal.addEventListener("abort", abortHandler, {
            once: true,
          });
        }

        try {
          const result = await fn();
          if (!isAborted) {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          return result;
        } catch (error) {
          if (!isAborted) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          throw error;
        } finally {
          if (abortHandler && context.signal) {
            context.signal.removeEventListener("abort", abortHandler);
          }
          if (!isAborted) {
            span.end();
          }
        }
      },
    );
  }
}
