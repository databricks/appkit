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
  ToolProvider,
} from "shared";
export { DatabricksAdapter, parseTextToolCalls } from "./agents/databricks";

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
  mcpServer,
  resolveHostedTools,
  type ToolConfig,
  type ToolEntry,
  type ToolRegistry,
  tool,
  toolsFromRegistry,
} from "./core/agent/tools";
export {
  type AgentTool,
  isToolkitEntry,
  type ToolkitEntry,
  type ToolkitOptions,
} from "./core/agent/types";

export * from "./plugins/beta-exports.generated";
