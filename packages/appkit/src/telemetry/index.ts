export type {
  Counter,
  Histogram,
  Span,
} from "@opentelemetry/api";
export { SpanKind, SpanStatusCode } from "@opentelemetry/api";
export { SeverityNumber } from "@opentelemetry/api-logs";
export { normalizeTelemetryOptions } from "./config";
export { instrumentations } from "./instrumentations";
export { TelemetryManager } from "./telemetry-manager";
export { TelemetryProvider } from "./telemetry-provider";
export type {
  ITelemetry,
  TelemetryConfig,
} from "./types";
