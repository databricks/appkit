export type {
  Attributes,
  Counter,
  Histogram,
  Meter,
  Span,
  SpanOptions,
  Tracer,
} from "@opentelemetry/api";
export { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
export type { LogAttributes, Logger, LogRecord } from "@opentelemetry/api-logs";
export { SeverityNumber } from "@opentelemetry/api-logs";
export { normalizeTelemetryOptions } from "./config";
export { TelemetryManager } from "./telemetry-manager";
export { TelemetryProvider } from "./telemetry-provider";
export type {
  InstrumentConfig,
  ITelemetry,
  TelemetryConfig,
} from "./types";
