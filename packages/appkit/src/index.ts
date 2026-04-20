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
export type { AgentHandle, CreateAgentConfig } from "./core/create-agent";
/**
 * @deprecated Use `createAgent(def)` (pure factory) together with the
 *   `agents()` plugin and `createApp`. This shortcut composes server +
 *   agent plugins in a single call; the new shape separates those concerns.
 *   Import path preserved for backward compatibility during migration.
 */
export { createAgent as createAgentApp } from "./core/create-agent";
// New pure-data agent factory (replaces the old createAgent shortcut once
// callers migrate — they coexist during the deprecation window).
export { createAgent } from "./core/create-agent-def";
export {
  type RunAgentInput,
  type RunAgentResult,
  runAgent,
} from "./core/run-agent";
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
export {
  type ExecutionResult,
  Plugin,
  type ToPlugin,
  toPlugin,
} from "./plugin";
export {
  /** @deprecated Use `agents()` (plural) instead. Kept for migration. */
  agent,
  analytics,
  files,
  genie,
  lakebase,
  server,
  serving,
} from "./plugins";
export {
  type FunctionTool,
  type HostedTool,
  isFunctionTool,
  isHostedTool,
  mcpServer,
  type ToolConfig,
  tool,
} from "./plugins/agent/tools";
export {
  type AgentDefinition,
  type AgentsPluginConfig,
  type AgentTool,
  agents,
  type BaseSystemPromptOption,
  isToolkitEntry,
  loadAgentFromFile,
  loadAgentsFromDir,
  type PromptContext,
  type ToolkitEntry,
  type ToolkitOptions,
} from "./plugins/agents";
export type {
  EndpointConfig,
  ServingEndpointEntry,
  ServingEndpointRegistry,
  ServingFactory,
} from "./plugins/serving/types";
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
export {
  extractServingEndpoints,
  findServerFile,
} from "./type-generator/serving/server-file-extractor";
export { appKitServingTypesPlugin } from "./type-generator/serving/vite-plugin";
// Vite plugin and type generation
export { appKitTypesPlugin } from "./type-generator/vite-plugin";
