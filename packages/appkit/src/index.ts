/**
 * @packageDocumentation
 *
 * Core library for building Databricks applications with type-safe SQL queries,
 * plugin architecture, and React integration.
 */

// Types from shared
export type {
  BasePluginConfig,
  CacheConfig,
  IAppRouter,
  StreamExecutionSettings,
} from "shared";
export { isSQLTypeMarker, sql } from "shared";
export { CacheManager } from "./cache";
export { getExecutionContext } from "./context";
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
export { analytics, server } from "./plugins";
// Registry types and utilities for plugin manifests
export type {
  ConfigSchema,
  PluginManifest,
  ResourceEntry,
  ResourceFieldEntry,
  ResourcePermission,
  ResourceRequirement,
  ValidationResult,
} from "./registry";
export {
  getPluginManifest,
  getResourceRequirements,
  ResourceRegistry,
  ResourceType,
} from "./registry";
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
// Vite plugin and type generation
export { appKitTypesPlugin } from "./type-generator/vite-plugin";
