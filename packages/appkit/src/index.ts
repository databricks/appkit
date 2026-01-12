// Types from shared
export type {
  BasePluginConfig,
  CacheConfig,
  IAppRouter,
  StreamExecutionSettings,
} from "shared";
export { isSQLTypeMarker, sql } from "shared";

// Core
export { createApp } from "./core";
export { analytics } from "./analytics";
export { server } from "./server";

// Plugin authoring
export { Plugin, toPlugin } from "./plugin";
export { CacheManager } from "./cache";

// Observability
export {
  SeverityNumber,
  SpanStatusCode,
  otel,
  type Span,
  type Counter,
  type Histogram,
  type ObservabilityConfig,
  type TelemetryConfig,
} from "./observability";

// Vite plugin
export { appKitTypesPlugin } from "./type-generator/vite-plugin";
