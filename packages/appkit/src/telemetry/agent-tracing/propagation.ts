import {
  context,
  isSpanContextValid,
  propagation,
  type Span,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { getMlflowUcTraceId } from "../mlflow-uc";

const MLFLOW_V4_TRACE_ID = /^trace:\/[^/]+\/([0-9a-f]{32})$/;

export interface RemoteTraceReference {
  traceId: string;
  otelTraceId: string;
  spanId: string;
  source: "model-serving" | "supervisor" | "mcp" | "remote-agent";
}

/**
 * Replaces any stale W3C headers with the currently active sampled context.
 * The caller owns the Headers instance and must allocate one per request.
 */
export function injectActiveTraceContext(headers: Headers): Headers {
  headers.delete("traceparent");
  headers.delete("tracestate");

  const activeContext = context.active();
  const activeSpan = trace.getSpan(activeContext);
  if (!activeSpan || !isSpanContextValid(activeSpan.spanContext())) {
    return headers;
  }

  const carrier: Record<string, string> = {};
  propagation.inject(activeContext, carrier);
  for (const [key, value] of Object.entries(carrier)) headers.set(key, value);
  return headers;
}

/**
 * Links a valid remote MLflow trace when it is not the same UC trace record
 * already represented by the local span.
 */
export function attachRemoteTraceLink(
  span: Span,
  reference: RemoteTraceReference,
): void {
  const mlflowMatch = MLFLOW_V4_TRACE_ID.exec(reference.traceId);
  const remoteContext = {
    traceId: reference.otelTraceId,
    spanId: reference.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  if (
    !mlflowMatch ||
    mlflowMatch[1] !== reference.otelTraceId ||
    !isSpanContextValid(remoteContext)
  ) {
    return;
  }

  const localContext = span.spanContext();
  if (getMlflowUcTraceId(localContext.traceId) === reference.traceId) return;

  span.addLink({
    context: remoteContext,
    attributes: {
      "mlflow.traceRequestId": reference.traceId,
      "appkit.remote_trace.source": reference.source,
    },
  });
}
