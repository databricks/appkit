// Re-exports of agent primitives that now live in core/agent/. Kept here so
// the public package barrel (`@databricks/appkit`) and any callers that
// already imported via `./plugins/agents` continue to resolve unchanged.
export { buildToolkitEntries } from "../../core/agent/build-toolkit";
export {
  agentIdFromMarkdownPath,
  type LoadContext,
  type LoadResult,
  loadAgentFromFile,
  loadAgentsFromDir,
  parseFrontmatter,
} from "../../core/agent/load-agents";
export {
  type AgentDefinition,
  type AgentsPluginConfig,
  type AgentTool,
  type AgentTools,
  type AgentToolsFn,
  type AutoInheritToolsConfig,
  type BaseSystemPromptOption,
  isToolkitEntry,
  type Plugins,
  type PluginToolkitProvider,
  type PromptContext,
  type RegisteredAgent,
  type ResolvedToolEntry,
  type ToolkitEntry,
  type ToolkitOptions,
} from "../../core/agent/types";
export { AgentsPlugin, agents } from "./agents";
