// Types from shared
export type {
  BasePluginConfig,
  CacheConfig,
  IAppRouter,
  StreamExecutionSettings,
} from "shared";
export { isSQLTypeMarker, sql } from "shared";
export { analytics } from "./analytics";
export { CacheManager } from "./cache";
export { createApp } from "./core";
// Errors
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
// Plugin authoring
export { Plugin, toPlugin } from "./plugin";
export { server } from "./server";
// Telemetry (for advanced custom telemetry)
export {
  type Counter,
  type Histogram,
  type ITelemetry,
  SeverityNumber,
  type Span,
  SpanStatusCode,
  type TelemetryConfig,
} from "./telemetry";

// Vite plugin
export { appKitTypesPlugin } from "./type-generator/vite-plugin";
export { getExecutionContext } from "./context";
