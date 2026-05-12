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
export { DatabricksAdapter, parseTextToolCalls } from "./agents/databricks";

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

export * from "./plugins/beta-exports.generated";
