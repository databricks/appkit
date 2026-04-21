import type {
  AgentAdapter,
  AgentToolDefinition,
  BasePluginConfig,
  ThreadStore,
  ToolAnnotations,
} from "shared";
import type { FromPluginMarker } from "./from-plugin";
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
 * Context passed to `baseSystemPrompt` callbacks.
 */
export interface PromptContext {
  agentName: string;
  pluginNames: string[];
  toolNames: string[];
}

export type BaseSystemPromptOption =
  | false
  | string
  | ((ctx: PromptContext) => string);

/**
 * Per-agent tool record. String keys map to inline tools, toolkit entries,
 * hosted tools, etc. Symbol keys hold `FromPluginMarker` references produced
 * by `fromPlugin(factory)` spreads — these are resolved at
 * `AgentsPlugin.setup()` time against registered `ToolProvider` plugins.
 */
export type AgentTools = { [key: string]: AgentTool } & {
  [key: symbol]: FromPluginMarker;
};

export interface AgentDefinition {
  /** Filled in from the enclosing key when used in `agents: { foo: def }`. */
  name?: string;
  /** System prompt body. For markdown-loaded agents this is the file body. */
  instructions: string;
  /**
   * Model adapter (or endpoint-name string sugar for
   * `DatabricksAdapter.fromServingEndpoint({ endpointName })`). Optional —
   * falls back to the plugin's `defaultModel`.
   */
  model?: AgentAdapter | Promise<AgentAdapter> | string;
  /** Per-agent tool record. Key is the LLM-visible tool-call name. */
  tools?: AgentTools;
  /** Sub-agents, exposed as `agent-<key>` tools on this agent. */
  agents?: Record<string, AgentDefinition>;
  /** Override the plugin's baseSystemPrompt for this agent only. */
  baseSystemPrompt?: BaseSystemPromptOption;
  maxSteps?: number;
  maxTokens?: number;
}

/**
 * Asymmetric auto-inherit configuration. `true` on either side means "spread
 * every registered ToolProvider plugin's toolkit() output into this agent's
 * tool record when it declares no explicit tools/toolkits".
 */
export interface AutoInheritToolsConfig {
  /** Default for agents loaded from markdown files. Default: `true`. */
  file?: boolean;
  /** Default for code-defined agents (via `agents: { foo: createAgent(...) }`). Default: `false`. */
  code?: boolean;
}

export interface AgentsPluginConfig extends BasePluginConfig {
  /** Directory to scan for markdown agent files. Default `./config/agents`. Set to `false` to disable. */
  dir?: string | false;
  /** Code-defined agents, merged with file-loaded ones (code wins on key collision). */
  agents?: Record<string, AgentDefinition>;
  /** Agent used when clients don't specify one. Defaults to the first-registered agent or the file with `default: true` frontmatter. */
  defaultAgent?: string;
  /** Default model for agents that don't specify their own (in code or frontmatter). */
  defaultModel?: AgentAdapter | Promise<AgentAdapter> | string;
  /** Ambient tool library. Keys may be referenced by markdown frontmatter via `tools: [key1, key2]`. */
  tools?: Record<string, AgentTool>;
  /** Whether to auto-inherit every ToolProvider plugin's toolkit. Accepts a boolean shorthand. */
  autoInheritTools?: boolean | AutoInheritToolsConfig;
  /** Persistent thread store. Default: in-memory. */
  threadStore?: ThreadStore;
  /** Customize or disable the AppKit base system prompt. */
  baseSystemPrompt?: BaseSystemPromptOption;
}

/** Internal tool-index entry after a tool record has been resolved to a dispatchable form. */
export type ResolvedToolEntry =
  | {
      source: "toolkit";
      pluginName: string;
      localName: string;
      def: AgentToolDefinition;
    }
  | {
      source: "function";
      functionTool: FunctionTool;
      def: AgentToolDefinition;
    }
  | {
      source: "mcp";
      mcpToolName: string;
      def: AgentToolDefinition;
    }
  | {
      source: "subagent";
      agentName: string;
      def: AgentToolDefinition;
    };

export interface RegisteredAgent {
  name: string;
  instructions: string;
  adapter: AgentAdapter;
  toolIndex: Map<string, ResolvedToolEntry>;
  baseSystemPrompt?: BaseSystemPromptOption;
  maxSteps?: number;
  maxTokens?: number;
}

/**
 * Type guard for `ToolkitEntry` — used by the agents plugin to differentiate
 * toolkit references from inline tools in a mixed `tools` record.
 */
export function isToolkitEntry(value: unknown): value is ToolkitEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __toolkitRef?: unknown }).__toolkitRef === true
  );
}
