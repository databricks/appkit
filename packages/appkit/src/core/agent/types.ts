import type {
  AgentAdapter,
  AgentToolDefinition,
  BasePluginConfig,
  ThreadStore,
  ToolAnnotations,
} from "shared";
import type { z } from "zod";

import type { GenerationParams } from "../../agents/databricks";
import type { McpHostPolicyConfig } from "../../connectors/mcp";
import type { ResolvedSkillCatalog } from "./skills/types";
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
 * tools (`mcpServer()` / raw hosted), toolkit references from plugins
 * (`analytics().toolkit()`), or adapter-hosted Supervisor-API tools
 * (`supervisorTools.*`).
 */
export type AgentTool =
  | FunctionTool
  | HostedTool
  | ToolkitEntry
  | import("../../agents/supervisor-api").HostedSupervisorTool;

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

export interface AgentDefinition<TOutput = string> {
  /**
   * Stable identifier for the agent. **Optional and informational** —
   * when the definition is registered via `agents: { foo: def }` (code) or
   * lives at `server/agents/<id>/agent.md` (markdown), the **registry key
   * always wins** and `name` is ignored. The agent will be reachable as
   * `foo` (or `<id>`) regardless of what this field contains.
   *
   * Set `name` when:
   *   - Running standalone via `runAgent({ agent: def })`, where there is
   *     no enclosing key. The runtime uses it for the agent's slot in
   *     error messages and OTel spans.
   *   - Building a definition that may be passed to either form and you
   *     want a consistent fallback label.
   *
   * Setting `name` to a value that differs from the registry key is
   * harmless but confusing — prefer keeping them aligned or omitting `name`
   * entirely.
   */
  name?: string;
  /**
   * Marks this agent as the default one chosen when a client doesn't name an
   * agent. Mirrors markdown frontmatter `default: true`. When several agents
   * set it, a code (discovered) agent wins over a markdown one, then the
   * lowest id; an explicit `agents({ defaultAgent })` always overrides it.
   * Defaults to `false`.
   */
  default?: boolean;
  /** System prompt body. For markdown-loaded agents this is the file body. */
  instructions: string;
  /**
   * Optional Zod schema the agent's final answer is validated against. When
   * set, the agent returns a typed object instead of freeform text: the
   * `/invocations` envelope gains a top-level `output_parsed` field, `/chat`
   * emits a final `structured_output` SSE event, and in-process `runAgent`
   * populates `RunAgentResult.output`. Prefer {@link createAgent} with an
   * `output` schema so the in-process result is statically typed via
   * `z.infer`. Code-config agents only — markdown `agent.md` agents cannot
   * carry a schema.
   */
  output?: z.ZodType<TOutput>;
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
  /**
   * Names of global skills (shared `skills/` pool or catalog volume) to make
   * visible to this agent. Per-agent skills under `<id>/skills/` are always
   * visible and need not be listed. Ignored when the plugin's
   * `autoInheritSkills` makes every global skill visible.
   */
  skills?: string[];
  /** Override the plugin's baseSystemPrompt for this agent only. */
  baseSystemPrompt?: BaseSystemPromptOption;
  maxSteps?: number;
  maxTokens?: number;
  /**
   * Optional generation parameters (`temperature`, `top_p`, `stop`,
   * `frequency_penalty`, `presence_penalty`) forwarded to the OpenAI-compatible
   * serving request body. Only set keys are sent. Applied only when AppKit
   * builds the adapter itself (string or omitted `model`); when you pass a
   * pre-built `AgentAdapter`, configure generation params on it directly.
   */
  generationParams?: GenerationParams;
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
 * automatically and must be wired via `tools:` (object or function form in
 * code, `plugin:NAME` entries in markdown frontmatter).
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
  /**
   * @deprecated Put each code agent in its own folder under
   * `server/agents/<id>/agent.ts` (`export default createAgent({ ... })`); it is
   * discovered automatically at startup and the call collapses to
   * `agents({ ... })` with no map. Still honored for backward compatibility
   * (emits a one-time deprecation warning) but will be removed in a future
   * minor. If both discovery and this map define the same id, discovery wins
   * and the map entry is ignored.
   */
  agents?: Record<string, AgentDefinition>;
  /** Agent used when clients don't specify one. Precedence: this value, else a code agent with `default: true`, else a markdown agent with `default: true`, else the first-registered agent. */
  defaultAgent?: string;
  /** Default model for agents that don't specify their own (in code or frontmatter). */
  defaultModel?: AgentAdapter | Promise<AgentAdapter> | string;
  /** Ambient tool library. Keys may be referenced by markdown frontmatter via `tools: [key1, key2]`. */
  tools?: Record<string, AgentTool>;
  /** Whether to auto-inherit every ToolProvider plugin's toolkit. Accepts a boolean shorthand. */
  autoInheritTools?: boolean | AutoInheritToolsConfig;
  /**
   * Whether every global skill (shared `skills/` pool or catalog volume) is
   * visible to an agent without listing it in `skills:` frontmatter. Off by
   * default so each agent's always-on skill catalog stays lean; accepts a
   * boolean shorthand or a per-origin `{ file, code }` config, mirroring
   * {@link autoInheritTools}.
   */
  autoInheritSkills?: boolean | AutoInheritToolsConfig;
  /**
   * Unity Catalog Volume path for catalog-sourced skills (e.g.
   * `/Volumes/<catalog>/<schema>/<volume>`). Falls back to the
   * `DATABRICKS_VOLUME_AGENT_SKILLS` env var. Skills at `<volume>/<name>/SKILL.md`
   * are discovered at boot and on `reload()` and read as the service principal.
   */
  skillsVolume?: string;
  /**
   * Identity used to read catalog (volume) skills. v1 supports `"sp"` (default —
   * a shared, service-principal-readable curated pool). `"obo"` is the reserved
   * switch point for per-user skill volumes and is not wired yet (falls back to
   * `"sp"` with a warning).
   */
  skillCredentialMode?: "sp" | "obo";
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
   * Human-in-the-loop approval gate for mutating tool calls. When enabled
   * (the default), the agents plugin emits an `appkit.approval_pending` SSE
   * event before executing any tool whose annotation flags it as mutating —
   * `effect: "write" | "update" | "destructive"` (preferred) or the legacy
   * `destructive: true` boolean — and waits for a `POST /api/agents/approve`
   * decision from the same user who initiated the stream. A missing decision
   * after `timeoutMs` auto-denies the call.
   */
  approval?: {
    /**
     * Require human approval for tools that mutate state. Triggered by
     * `effect: "write" | "update" | "destructive"` (preferred) or the legacy
     * `destructive: true` boolean. Default: `true`.
     */
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
    }
  | {
      /**
       * Adapter-side hosted tool (executed by the model-host, not by the
       * Node process). Today: Supervisor API hosted tools (Genie spaces,
       * UC functions, etc.). The `spec` is opaque to the agents plugin —
       * it routes the entry into `AgentInput.extensions` for the adapter
       * that declared the matching `acceptsExtensions` key. `def` is a
       * synthetic placeholder kept so the index has a uniform shape; it
       * is intentionally NOT included in the `tools` array passed to
       * `adapter.run()` (those entries are not callable functions).
       */
      source: "hosted-supervisor";
      spec: import("../../agents/supervisor-api").SupervisorTool;
      def: AgentToolDefinition;
    }
  | {
      /**
       * Built-in skill tools (`load_skill`, `read_skill_file`) injected into
       * any agent that has a visible skill catalog. Executed in-process by the
       * agents plugin against the agent's resolved catalog; read-only, so they
       * bypass the approval gate.
       */
      source: "skill";
      builtin: "load_skill" | "read_skill_file";
      catalog: ResolvedSkillCatalog;
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
  /** Mirrors `AgentDefinition.generationParams`. */
  generationParams?: GenerationParams;
  /** Mirrors `AgentDefinition.ephemeral` — skip thread persistence. */
  ephemeral?: boolean;
  /**
   * Mirrors `AgentDefinition.output` — the Zod schema the final answer is
   * validated against. Present only for agents that declared structured
   * output. Untyped here (the registry `Map` is string-keyed); `z.infer`
   * typing lives on `createAgent`/`runAgent`.
   */
  output?: z.ZodType;
  /**
   * Resolved per-agent skill catalog (visibility + collision rules applied).
   * Present when any skill is visible to this agent; drives the always-on
   * prompt catalog and `load_skill` dispatch.
   */
  skills?: ResolvedSkillCatalog;
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
