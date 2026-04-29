/**
 * Agent runtime primitives. All framework-level agent types, tool helpers,
 * and the standalone runner live here. The HTTP-facing `agents()` plugin in
 * `plugins/agents/` consumes these but does not own them — peer plugins
 * (analytics, files, genie, lakebase) can depend on this module without
 * reaching across the sibling boundary.
 */
export { buildToolkitEntries } from "./build-toolkit";
export { consumeAdapterStream } from "./consume-adapter-stream";
export { createAgent } from "./create-agent";
export {
  FROM_PLUGIN_MARKER,
  type FromPluginMarker,
  type FromPluginSpread,
  fromPlugin,
  isFromPluginMarker,
} from "./from-plugin";
export {
  agentIdFromMarkdownPath,
  type LoadContext,
  type LoadResult,
  loadAgentFromFile,
  loadAgentsFromDir,
  parseFrontmatter,
} from "./load-agents";
export { normalizeToolResult } from "./normalize-result";
export {
  type RunAgentInput,
  type RunAgentResult,
  runAgent,
} from "./run-agent";
export { buildBaseSystemPrompt, composeSystemPrompt } from "./system-prompt";
export { dispatchToolCall } from "./tool-dispatch";
export { resolveToolkitFromProvider } from "./toolkit-resolver";
export {
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
} from "./tools";
export {
  type AgentDefinition,
  type AgentsPluginConfig,
  type AgentTool,
  type AgentTools,
  type AutoInheritToolsConfig,
  type BaseSystemPromptOption,
  isToolkitEntry,
  type PromptContext,
  type RegisteredAgent,
  type ResolvedToolEntry,
  type ToolkitEntry,
  type ToolkitOptions,
} from "./types";
