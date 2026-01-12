export type { Counter, Histogram, Span } from "@opentelemetry/api";
export { SpanKind, SpanStatusCode } from "@opentelemetry/api";
export {
  AppKitError,
  AuthenticationError,
  ConfigurationError,
  ConnectionError,
  ExecutionError,
  InitializationError,
  ServerError,
  TunnelError,
  ValidationError,
} from "./errors";
export { createDebug } from "./debug";
export { WideEvent, type WideEventData } from "./wide-event";
export type { LogLevel } from "./types";
