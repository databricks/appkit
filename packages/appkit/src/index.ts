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

// Telemetry (for advanced custom telemetry)
export {
  SeverityNumber,
  SpanStatusCode,
  type TelemetryConfig,
  type Counter,
  type Histogram,
  type Span,
  type ITelemetry,
} from "./telemetry";

// Vite plugin
export { appKitTypesPlugin } from "./type-generator/vite-plugin";
