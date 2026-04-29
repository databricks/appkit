// Beta plugins and APIs -- may change between minor releases.
// These are on a path to GA and will graduate to '@databricks/appkit'.
//
// Plugin factory exports are auto-generated from each plugin's manifest.json
// "stability" field. See tools/generate-plugin-entries.ts.
export { DatabricksAdapter, parseTextToolCalls } from "./agents/databricks";

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

// Tool authoring primitives
export {
  type FunctionTool,
  type HostedTool,
  isFunctionTool,
  isHostedTool,
  mcpServer,
  type ToolConfig,
  tool,
} from "./core/agent/tools";
export {
  type AgentTool,
  isToolkitEntry,
  type ToolkitEntry,
  type ToolkitOptions,
} from "./core/agent/types";

export * from "./plugins/beta-exports.generated";
