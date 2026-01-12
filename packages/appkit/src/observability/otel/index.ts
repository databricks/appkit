import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

export const getTracer = trace.getTracer.bind(trace);
export const getMeter = metrics.getMeter.bind(metrics);
export const getLogger = logs.getLogger.bind(logs);

// Re-export useful OTEL types
export type {
  Counter,
  Histogram,
  Meter,
  Tracer,
} from "@opentelemetry/api";
export {
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
export type { Logger as OTELLogger } from "@opentelemetry/api-logs";

export { logs } from "@opentelemetry/api-logs";
