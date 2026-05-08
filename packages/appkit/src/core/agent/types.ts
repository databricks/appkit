import type {
  AgentAdapter,
  AgentToolDefinition,
  BasePluginConfig,
  ThreadStore,
  ToolAnnotations,
} from "shared";
import type { McpHostPolicyConfig } from "../../connectors/mcp";
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
 * Minimum shape every entry in the {@link Plugins} map must expose. Core
 * plugins (analytics, files, genie, lakebase) implement this directly via
 * their `.toolkit()` method. The agents plugin and standalone `runAgent`
 * synthesize this shape for any registered plugin that doesn't implement
 * `.toolkit()` directly (falling back to `getAgentTools()` walking).
 */
export interface PluginToolkitProvider {
  toolkit(opts?: ToolkitOptions): Record<string, ToolkitEntry>;
}

/**
 * Plugin map passed to the function form of {@link AgentDefinition.tools}.
 * Each entry exposes a `.toolkit(opts?)` method that returns a record of
 * {@link ToolkitEntry} markers ready to be spread into a tool record.
 *
 * AppKit does not statically know which plugins the surrounding
 * `createApp` will register, so this is a plain string-keyed record.
 * Refer to plugins by the name used in `createApp({ plugins: [...] })`;
 * unknown names resolve to `undefined` at runtime.
 *
 * @example
 * ```ts
 * const support = createAgent({
 *   instructions: "...",
 *   tools(plugins) {
 *     return {
 *       get_weather: tool({ ... }),
 *       ...plugins.analytics.toolkit(),
 *       ...plugins.files.toolkit({ only: ["uploads.read"] }),
 *     };
 *   },
 * });
 * ```
 */
export type Plugins = Record<string, PluginToolkitProvider>;

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
 * hosted tools, etc.
 */
export type AgentTools = Record<string, AgentTool>;

/**
 * Function form of `AgentDefinition.tools`. Receives the typed
 * {@link Plugins} map and returns a tool record. Invoked exactly once at
 * setup (or once per `runAgent` call in standalone mode); the result is
 * cached as the agent's resolved tool record.
 *
 * Use the function form when an agent needs tools from registered plugins.
 * The bare object form is fine when an agent only uses inline tools.
 */
export type AgentToolsFn = (plugins: Plugins) => AgentTools;

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
  /**
   * Per-agent tool record. Key is the LLM-visible tool-call name.
   *
   * Accepts either a plain record (for agents that only use inline tools)
   * or a function `(plugins) => Record<string, AgentTool>` that receives
   * the typed {@link Plugins} map and returns a tool record (for agents
   * that pull tools from registered plugins).
   *
   * The function is invoked once at agent setup; the result is cached.
   * Don't put per-request logic in there.
   */
  tools?: AgentTools | AgentToolsFn;
  /** Sub-agents, exposed as `agent-<key>` tools on this agent. */
  agents?: Record<string, AgentDefinition>;
  /** Override the plugin's baseSystemPrompt for this agent only. */
  baseSystemPrompt?: BaseSystemPromptOption;
  maxSteps?: number;
  maxTokens?: number;
  /**
   * When true, the thread used for a chat request against this agent is
   * deleted from `ThreadStore` after the stream completes (success or
   * failure). Use for stateless one-shot agents — e.g. autocomplete, where
   * each request is independent and retaining history would both poison
   * future calls and accumulate unbounded state in the default
   * `InMemoryThreadStore`. Defaults to `false`.
   */
  ephemeral?: boolean;
}

/**
 * Auto-inherit configuration. When enabled for a given agent origin, agents
 * with no explicit `tools:` declaration receive every registered ToolProvider
 * plugin tool whose author marked `autoInheritable: true`. Tools without that
 * flag — destructive, state-mutating, or privilege-sensitive — never spread
 * automatically and must be wired via `tools:` (object or function form) or
 * markdown `toolkits:`.
 *
 * Defaults are `false` for both origins (safe-by-default): developers must
 * consciously opt an origin in to any auto-inherit behaviour.
 */
export interface AutoInheritToolsConfig {
  /** Default for agents loaded from markdown files. Default: `false`. */
  file?: boolean;
  /** Default for code-defined agents (via `agents: { foo: createAgent(...) }`). Default: `false`. */
  code?: boolean;
}

export interface AgentsPluginConfig extends BasePluginConfig {
  /** Directory of agent packages (`<id>/agent.md` each). Default `./config/agents`. Set to `false` to disable. */
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
  /**
   * MCP server host policy. By default only same-origin Databricks workspace
   * URLs may be used as MCP endpoints; custom hosts must be explicitly
   * allowlisted here. Workspace credentials (SP / OBO) are never forwarded
   * to non-workspace hosts.
   */
  mcp?: McpHostPolicyConfig;
  /**
   * Human-in-the-loop approval gate for destructive tool calls. When enabled
   * (the default), the agents plugin emits an `appkit.approval_pending` SSE
   * event before executing any tool annotated `destructive: true` and waits
   * for a `POST /chat/approve` decision from the same user who initiated the
   * stream. A missing decision after `timeoutMs` auto-denies the call.
   */
  approval?: {
    /** Require human approval for tools annotated `destructive: true`. Default: `true`. */
    requireForDestructive?: boolean;
    /** Milliseconds to wait before auto-denying. Default: 60_000. */
    timeoutMs?: number;
  };
  /**
   * Runtime resource limits applied during agent execution. Defaults are
   * tuned to protect a single-instance deployment from a misbehaving user or
   * a runaway prompt injection; tighten or relax as appropriate for the
   * deployment's scale and trust model. Request-body caps (chat message
   * size, invocations input size / length) are enforced statically by the
   * Zod schemas and are not configurable here.
   */
  limits?: {
    /**
     * Max concurrent chat streams a single user may have open. Subsequent
     * `POST /chat` requests from that user while at-limit are rejected with
     * HTTP 429. Default: `5`.
     */
    maxConcurrentStreamsPerUser?: number;
    /**
     * Max tool invocations per agent run (across the full tool-call graph,
     * including sub-agent invocations). A run that exceeds the budget is
     * aborted with a terminal error event. Default: `50`.
     */
    maxToolCalls?: number;
    /**
     * Max sub-agent recursion depth. Protects against a prompt-injected
     * agent that delegates to a sub-agent which in turn delegates back to
     * itself (directly or transitively). Default: `3`.
     */
    maxSubAgentDepth?: number;
    /**
     * Per-call timeout for tools dispatched through `PluginContext`
     * (toolkit-routed tools — analytics SQL warehouse queries, Genie
     * messages, Lakebase queries). Independent of `maxToolCalls`: the
     * budget caps how many tools fire per run, this caps how long any
     * single tool call may run. The signal handed to plugin tool
     * implementations combines this timeout with the parent stream's
     * abort signal via `AbortSignal.any`. Function and MCP tools have
     * their own timeouts in their respective adapters and ignore this
     * setting. Default: `300_000` (5 minutes) — generous enough for cold
     * SQL Warehouse round-trips and long Genie conversations.
     */
    toolCallTimeoutMs?: number;
  };
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
  /** Mirrors `AgentDefinition.ephemeral` — skip thread persistence. */
  ephemeral?: boolean;
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
