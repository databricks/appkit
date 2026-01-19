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
} from "../errors";
export { createLogger, type Logger, wideEventMiddleware } from "./logger";
export {
  DEFAULT_SAMPLING_CONFIG,
  type SamplingConfig,
  shouldSample,
} from "./sampling";
export type { LogLevel } from "./types";
export { WideEvent, type WideEventData } from "./wide-event";
export { WideEventEmitter } from "./wide-event-emitter";
