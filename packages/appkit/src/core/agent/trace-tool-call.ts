import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ToolEffect } from "shared";
import { captureTraceValue } from "../../telemetry/agent-tracing";

const tracer = () => trace.getTracer("@databricks/appkit-agent-tracing");

export async function traceToolCall<T>(
  input: {
    name: string;
    source: string;
    effect?: ToolEffect;
    args: unknown;
  },
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    `${input.name} tool`,
    {
      attributes: {
        "mlflow.spanType": "TOOL",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": input.name,
        "appkit.tool.name": input.name,
        "appkit.tool.source": input.source,
        ...(input.effect ? { "appkit.tool.effect": input.effect } : {}),
      },
    },
    async (span) => {
      const startedAt = Date.now();
      setCapturedAttribute(span, "mlflow.spanInputs", input.args);
      try {
        const result = await operation(span);
        setCapturedAttribute(span, "mlflow.spanOutputs", result);
        span.setAttribute("appkit.tool.state", "completed");
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setAttribute("appkit.tool.state", "failed");
        recordSafeFailure(span, error);
        throw error;
      } finally {
        span.setAttribute(
          "appkit.tool.duration_ms",
          Math.max(0, Date.now() - startedAt),
        );
        span.end();
      }
    },
  );
}

function setCapturedAttribute(span: Span, key: string, value: unknown): void {
  const captured = captureTraceValue(value);
  span.setAttribute(key, captured.value);
  span.setAttribute(`${key}.original_bytes`, captured.originalBytes);
  span.setAttribute(`${key}.sha256`, captured.sha256);
  span.setAttribute(`${key}.truncated`, captured.truncated);
}

function recordSafeFailure(span: Span, error: unknown): void {
  const failure = captureTraceValue(
    {
      error:
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error"),
    },
    { redactKeys: ["error"] },
  );
  span.setAttribute("appkit.error", failure.value);
  span.setAttribute("mlflow.spanOutputs", failure.value);
  span.setAttribute("mlflow.spanOutputs.original_bytes", failure.originalBytes);
  span.setAttribute("mlflow.spanOutputs.sha256", failure.sha256);
  span.setAttribute("mlflow.spanOutputs.truncated", failure.truncated);
  span.recordException({ name: "Error", message: "Tool operation failed" });
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: "Tool operation failed",
  });
}
