import type { AgentToolDefinition, ToolAnnotations } from "shared";
import type { FunctionTool } from "./tools/function-tool";
import type { HostedTool } from "./tools/hosted-tools";

/**
 * A tool reference produced by a plugin's `.toolkit()` call. The agents plugin
 * recognizes the `__toolkitRef` brand and dispatches tool invocations through
 * `PluginContext.executeTool(req, pluginName, localName, ...)`, preserving
 * OBO (asUser) and telemetry spans.
 */
export interface ToolkitEntry {
  readonly __toolkitRef: true;
  pluginName: string;
  localName: string;
  def: AgentToolDefinition;
  annotations?: ToolAnnotations;
  /**
   * Whether this tool is eligible for `autoInheritTools` spreading. Mirrors
   * {@link ToolEntry.autoInheritable} from the source registry so the agents
   * plugin can filter auto-inherited tools without re-walking the provider's
   * internal registry.
   */
  autoInheritable?: boolean;
}

/**
 * Any tool an agent can invoke: inline function tools (`tool()`), hosted MCP
 * tools (`mcpServer()` / raw hosted), or toolkit references from plugins
 * (`analytics().toolkit()`).
 */
export type AgentTool = FunctionTool | HostedTool | ToolkitEntry;

export interface ToolkitOptions {
  /** Key prefix to prepend to each tool's local name. Defaults to `${pluginName}.`. */
  prefix?: string;
  /** Only include tools whose local name matches one of these. */
  only?: string[];
  /** Exclude tools whose local name matches one of these. */
  except?: string[];
  /** Remap specific local names to different keys (applied after prefix). */
  rename?: Record<string, string>;
}

/**
 * Type guard for `ToolkitEntry` — used to differentiate toolkit references
 * from inline tools in a mixed `tools` record.
 */
export function isToolkitEntry(value: unknown): value is ToolkitEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __toolkitRef?: unknown }).__toolkitRef === true
  );
}
