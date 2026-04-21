/**
 * @packageDocumentation
 *
 * Core library for building Databricks applications with type-safe SQL queries,
 * plugin architecture, and React integration.
 */

// Types from shared
export type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
  BasePluginConfig,
  CacheConfig,
  IAppRouter,
  Message,
  PluginData,
  StreamExecutionSettings,
  Thread,
  ThreadStore,
  ToolProvider,
} from "shared";
export { isSQLTypeMarker, sql } from "shared";
export type {
  AppTool,
  GenieSpaceTool,
  KnowledgeAssistantTool,
  SupervisorApiHostedTool,
  UcConnectionTool,
  UcFunctionTool,
} from "./agents/responses";
export { CacheManager } from "./cache";
export type {
  DatabaseCredential,
  GenerateDatabaseCredentialRequest,
  LakebasePoolConfig,
  RequestedClaims,
  RequestedResource,
} from "./connectors/lakebase";
// Lakebase Autoscaling connector
export {
  createLakebasePool,
  generateDatabaseCredential,
  getLakebaseOrmConfig,
  getLakebasePgConfig,
  getUsernameWithApiLookup,
  getWorkspaceClient,
  RequestedClaimsPermissionSet,
} from "./connectors/lakebase";
export { getExecutionContext } from "./context";
export { createApp } from "./core";
export {
  type AgentHandle,
  type CreateAgentConfig,
  createAgent,
} from "./core/create-agent";
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
export { Plugin, type ToPlugin, toPlugin } from "./plugin";
export { agent, analytics, files, genie, lakebase, server } from "./plugins";
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
