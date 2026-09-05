// Beta plugins -- APIs may change between minor releases.
// These plugins are on a path to GA and will graduate.
// Import from '@databricks/appkit' once a plugin graduates to GA.
//
// The exports below are auto-generated from each plugin's manifest.json
// "stability" field. See tools/generate-plugin-entries.ts.

// Agent types from shared
export type {
  AgentAdapter,
  AgentEvent,
  AgentInput,
  AgentRunContext,
  AgentToolDefinition,
  Message,
  Thread,
  ThreadStore,
  ToolAnnotations,
  ToolProvider,
} from "shared";
export {
  DatabricksAdapter,
  type GenerationParams,
  parseTextToolCalls,
} from "./agents/databricks";
export type {
  HostedSupervisorTool,
  SupervisorApiAdapterOptions,
  SupervisorExtension,
  SupervisorTool,
  WorkspaceClientLike,
} from "./agents/supervisor-api";
export {
  fromSupervisorApi,
  isSupervisorTool,
  SUPERVISOR_EXTENSION_KEY,
  SupervisorApiAdapter,
  supervisorTools,
} from "./agents/supervisor-api";

// Agent runtime
export { createAgent } from "./core/agent/create-agent";
export {
  type RunAgentInput,
  type RunAgentResult,
  runAgent,
} from "./core/agent/run-agent";

// Tool authoring primitives
export {
  AppKitMcpClient,
  defineTool,
  executeFromRegistry,
  type FunctionTool,
  functionToolToDefinition,
  type HostedTool,
  isFunctionTool,
  isHostedTool,
  type McpConnectAllResult,
  mcpServer,
  resolveHostedTools,
  type ToolConfig,
  type ToolEntry,
  type ToolRegistry,
  tool,
  toolsFromRegistry,
} from "./core/agent/tools";

export type { Schema } from "./database/schema-builder";
export {
  bigid,
  bigint,
  boolean,
  defineSchema,
  enumColumn,
  fk,
  id,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
} from "./database/schema-builder";

// Agent evaluation (eve-style authoring, reports to MLflow)
export * from "./evals";
// Agent types
export type {
  AgentDefinition,
  AgentsPluginConfig,
  AgentTool,
  AgentTools,
  AgentToolsFn,
  AutoInheritToolsConfig,
  BaseSystemPromptOption,
  Plugins,
  PluginToolkitProvider,
  PromptContext,
  RegisteredAgent,
  ResolvedToolEntry,
  ToolkitEntry,
  ToolkitOptions,
} from "./plugins/agents";
export {
  agentIdFromMarkdownPath,
  isToolkitEntry,
  loadAgentFromFile,
  loadAgentsFromDir,
} from "./plugins/agents";
// AI Search plugin config and query types (the `aiSearch` binding
// itself is exported via the generated barrel above).
export type {
  IAiSearchConfig,
  IndexConfig,
  RerankerConfig,
  SearchFilters,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "./plugins/ai-search/types";
export * from "./plugins/beta-exports.generated";
export type {
  DatabaseApiConfig,
  DatabaseApiWriteOperation,
  DatabaseApiWritesConfig,
  DatabaseExports,
  EntityHooks,
  EntityMutationHooks,
  HookApp,
  HookContext,
  IDatabaseConfig,
  ReadSerializer,
  ReadSerializerContext,
  TransactionClient,
} from "./plugins/database";
