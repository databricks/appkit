export type { Counter, Histogram, Span } from "@opentelemetry/api";
export { SpanKind, SpanStatusCode } from "@opentelemetry/api";
export { LoggerManager } from "./logger-manager";
export * as otel from "./otel";
export type {
  ErrorLogOptions,
  ILogger,
  LogContext,
  MetricOptions,
  ObservabilityConfig,
  ObservabilityOptions,
  SpanOptions,
} from "./types";
