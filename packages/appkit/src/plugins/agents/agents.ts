import { randomUUID } from "node:crypto";
import path from "node:path";
import type express from "express";
import pc from "picocolors";
import type {
  AgentAdapter,
  AgentEvent,
  AgentRunContext,
  AgentToolDefinition,
  IAppRouter,
  Message,
  PluginPhase,
  ResponseOutputMessage,
  ResponseStreamEvent,
  Thread,
  ToolAnnotations,
  ToolProvider,
} from "shared";
import { AppKitMcpClient, buildMcpHostPolicy } from "../../connectors/mcp";
import { getWorkspaceClient } from "../../context";
import { consumeAdapterStream } from "../../core/agent/consume-adapter-stream";
import { loadAgentsFromDir } from "../../core/agent/load-agents";
import { normalizeToolResult } from "../../core/agent/normalize-result";
import { createPluginsProxy } from "../../core/agent/plugins-map";
import {
  buildBaseSystemPrompt,
  composeSystemPrompt,
} from "../../core/agent/system-prompt";
import { resolveToolkitFromProvider } from "../../core/agent/toolkit-resolver";
import {
  functionToolToDefinition,
  isFunctionTool,
  isHostedTool,
  resolveHostedTools,
} from "../../core/agent/tools";
import type {
  AgentDefinition,
  AgentsPluginConfig,
  AgentTools,
  BaseSystemPromptOption,
  Plugins,
  PluginToolkitProvider,
  PromptContext,
  RegisteredAgent,
  ResolvedToolEntry,
} from "../../core/agent/types";

/**
 * Reject client-tool catalogs that would shadow the agent's static tools or
 * collide with each other. Returning a string surfaces a 400 to the client
 * synchronously rather than a half-streamed SSE error mid-conversation.
 *
 * Collision detection is one-shot at chat-handler entry; the catalog is
 * frozen for the lifetime of the request and cannot drift mid-stream.
 */
function validateClientToolCatalog(
  uiTools: AgentToolDefinition[],
  staticIndex: Map<string, ResolvedToolEntry>,
): string | null {
  const seen = new Set<string>();
  for (const def of uiTools) {
    if (seen.has(def.name)) {
      return `Duplicate uiTools entry: '${def.name}' appears more than once in the catalog`;
    }
    seen.add(def.name);
    if (staticIndex.has(def.name)) {
      return `uiTools entry '${def.name}' collides with an agent-registered tool of the same name`;
    }
  }
  return null;
}

import { isToolkitEntry } from "../../core/agent/types";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { ClientToolGate } from "./client-tool-gate";
import { agentStreamDefaults } from "./defaults";
import { EventChannel } from "./event-channel";
import { AgentEventTranslator } from "./event-translator";
import manifest from "./manifest.json";
import { McpBridge } from "./mcp-bridge";
import {
  approvalRequestSchema,
  cancelRequestSchema,
  chatRequestSchema,
  clientToolResultSchema,
  invocationsRequestSchema,
  registerToolsSchema,
} from "./schemas";
import { InMemoryThreadStore } from "./thread-store";
import { ToolApprovalGate } from "./tool-approval-gate";
import { ToolSessionRegistry } from "./tool-session-registry";

const logger = createLogger("agents");

const DEFAULT_AGENTS_DIR = "./config/agents";

/**
 * Context flag recorded on the in-memory AgentDefinition to indicate whether
 * it came from markdown (file) or from user code. Drives the asymmetric
 * `autoInheritTools` default.
 */
interface AgentSource {
  origin: "file" | "code";
}

/**
 * Decide whether a tool call must traverse the approval gate. Honours both
 * the modern `effect` field (mutating values: write / update / destructive)
 * and the legacy `destructive: true` boolean. The contract is documented on
 * `ToolAnnotations.effect` in shared/agent.ts.
 *
 * Without this, a tool authored only with `effect: "destructive"` (the
 * preferred API) bypassed the gate entirely.
 */
function requiresApproval(annotations: ToolAnnotations | undefined): boolean {
  if (!annotations) return false;
  if (annotations.destructive === true) return true;
  switch (annotations.effect) {
    case "write":
    case "update":
    case "destructive":
      return true;
    case "read":
    case undefined:
      return false;
    default: {
      const _exhaustive: never = annotations.effect;
      return false;
    }
  }
}

/**
 * Per-stream state shared between the top-level `executeTool` and any
 * `runSubAgent` calls below it. Carrying the budget counter, abort signal,
 * approval policy, and event-channel through one object is what lets the
 * sub-agent path enforce the same limits and approval gate as the parent.
 *
 * Without this shared state the sub-agent path silently bypassed both the
 * tool-call budget and the destructive-tool approval gate.
 */
interface RunState {
  req: express.Request;
  userId: string;
  requestId: string;
  abortController: AbortController;
  signal: AbortSignal;
  approvalPolicy: { requireForDestructive: boolean; timeoutMs: number };
  limits: {
    maxConcurrentStreamsPerUser: number;
    maxToolCalls: number;
    maxSubAgentDepth: number;
    toolCallTimeoutMs: number;
  };
  translator: AgentEventTranslator;
  outboundEvents: EventChannel<ResponseStreamEvent>;
  /** Boxed mutable counter shared across parent + all sub-agent dispatches. */
  toolCallsUsed: { count: number };
  /**
   * Browser tool-session this run is bound to. Client (UI) tool calls are
   * delivered over that session's persistent channel. Undefined when the chat
   * request carried no `sessionId` (no UI tools in play).
   */
  sessionId?: string;
  /**
   * Call ids for client-tool round trips spawned by this run, so the run's
   * teardown can cancel any still in flight (they're keyed by session, not by
   * run, on the shared gate).
   */
  clientCallIds: Set<string>;
}

export class AgentsPlugin extends Plugin implements ToolProvider {
  static manifest = manifest as PluginManifest;
  static phase: PluginPhase = "deferred";

  protected declare config: AgentsPluginConfig;

  private agents = new Map<string, RegisteredAgent>();
  private defaultAgentName: string | null = null;
  private activeStreams = new Map<
    string,
    { controller: AbortController; userId: string }
  >();
  /**
   * Per-user stream count, kept in sync with `activeStreams` so the
   * concurrent-stream rate limit check is O(1) instead of O(n) over every
   * active stream on every request. Mutated only via {@link trackStream}
   * and {@link untrackStream}.
   */
  private userStreamCounts = new Map<string, number>();
  private mcpClient: AppKitMcpClient | null = null;
  private threadStore;
  private approvalGate = new ToolApprovalGate();
  private clientToolGate = new ClientToolGate();
  private toolSessions = new ToolSessionRegistry();
  private mcpBridge: McpBridge | null = null;

  constructor(config: AgentsPluginConfig) {
    super(config);
    this.config = config;
    if (config.threadStore) {
      this.threadStore = config.threadStore;
    } else {
      this.threadStore = new InMemoryThreadStore();
      if (process.env.NODE_ENV === "production") {
        logger.warn(
          "InMemoryThreadStore is in use in a production build (NODE_ENV=production). " +
            "Thread history is unbounded and lost on restart. " +
            "Pass agents({ threadStore: <persistent impl> }) for real deployments.",
        );
      } else {
        logger.info(
          "Using default InMemoryThreadStore (dev-only — threads are lost on restart and grow without bound).",
        );
      }
    }
  }

  /**
   * Effective approval policy with defaults applied. Memoised so the
   * `timeoutMs` validation warning fires at most once per plugin instance —
   * `resolvedApprovalPolicy` gets hit on every chat stream and a noisy
   * misconfig would otherwise spam the logs.
   *
   * `timeoutMs` is clamped to a 1s floor so a misconfigured value (`0`,
   * negative, or `NaN`) can't degrade into immediate auto-denial of every
   * mutating tool call.
   */
  private cachedApprovalPolicy: {
    requireForDestructive: boolean;
    timeoutMs: number;
  } | null = null;

  private get resolvedApprovalPolicy(): {
    requireForDestructive: boolean;
    timeoutMs: number;
  } {
    if (this.cachedApprovalPolicy) return this.cachedApprovalPolicy;
    const cfg = this.config.approval ?? {};
    const APPROVAL_TIMEOUT_FLOOR_MS = 1_000;
    const APPROVAL_TIMEOUT_DEFAULT_MS = 60_000;
    let timeoutMs = cfg.timeoutMs ?? APPROVAL_TIMEOUT_DEFAULT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < APPROVAL_TIMEOUT_FLOOR_MS) {
      logger.warn(
        "approval.timeoutMs=%s is below the %sms floor; using default %sms instead. Mutating tool calls would otherwise auto-deny before any UI could respond.",
        cfg.timeoutMs,
        APPROVAL_TIMEOUT_FLOOR_MS,
        APPROVAL_TIMEOUT_DEFAULT_MS,
      );
      timeoutMs = APPROVAL_TIMEOUT_DEFAULT_MS;
    }
    this.cachedApprovalPolicy = {
      requireForDestructive: cfg.requireForDestructive ?? true,
      timeoutMs,
    };
    return this.cachedApprovalPolicy;
  }

  /** Effective DoS limits with defaults applied. */
  private get resolvedLimits(): {
    maxConcurrentStreamsPerUser: number;
    maxToolCalls: number;
    maxSubAgentDepth: number;
    toolCallTimeoutMs: number;
  } {
    const cfg = this.config.limits ?? {};
    return {
      maxConcurrentStreamsPerUser: cfg.maxConcurrentStreamsPerUser ?? 5,
      maxToolCalls: cfg.maxToolCalls ?? 50,
      maxSubAgentDepth: cfg.maxSubAgentDepth ?? 3,
      // 5 minutes is the floor for cold SQL Warehouse / long Genie /
      // long Lakebase calls. The previous PluginContext default of 30s
      // truncated legitimate analytics queries on cold compute.
      toolCallTimeoutMs: cfg.toolCallTimeoutMs ?? 300_000,
    };
  }

  /** Count active streams owned by a given user. O(1). */
  private countUserStreams(userId: string): number {
    return this.userStreamCounts.get(userId) ?? 0;
  }

  /**
   * Register a stream for `userId` and bump the per-user counter. Paired
   * with {@link untrackStream}; the two helpers are the only writers to
   * `activeStreams` + `userStreamCounts`, so the counter cannot drift from
   * the map.
   */
  private trackStream(
    requestId: string,
    userId: string,
    controller: AbortController,
  ): void {
    this.activeStreams.set(requestId, { controller, userId });
    this.userStreamCounts.set(
      userId,
      (this.userStreamCounts.get(userId) ?? 0) + 1,
    );
  }

  /**
   * Remove a stream from the active map and decrement the per-user
   * counter. Idempotent — calling twice for the same `requestId` is a
   * no-op (the second call sees no entry and returns early).
   */
  private untrackStream(requestId: string): void {
    const entry = this.activeStreams.get(requestId);
    if (!entry) return;
    this.activeStreams.delete(requestId);
    const next = (this.userStreamCounts.get(entry.userId) ?? 0) - 1;
    if (next <= 0) {
      this.userStreamCounts.delete(entry.userId);
    } else {
      this.userStreamCounts.set(entry.userId, next);
    }
  }

  async setup() {
    const { agents, defaultAgentName } = await this.buildAgentRegistry();
    this.agents = agents;
    this.defaultAgentName = defaultAgentName;
    this.mountInvokeRoutes();
    this.printRegistry();
  }

  /**
   * Reload agents from the configured directory, preserving code-defined
   * agents. Builds a fresh registry first and only swaps on success — if
   * `loadAgents` throws (malformed markdown, missing tool reference) the
   * existing live registry stays in place and serving requests keep working.
   */
  async reload(): Promise<void> {
    const next = await this.buildAgentRegistry();
    // Deliberately NOT closing the existing mcpClient here. Tool
    // dispatch in `dispatchToolCall` reads `this.mcpClient` at call
    // time; closing it mid-stream throws "MCP client is closed" from
    // the next sendRpc and kills the in-flight conversation. The
    // client owns only short-lived `fetch` handles (no keep-alive
    // sockets) and the connections map persists in the live instance,
    // so dropping `this.mcpClient` would also strand in-flight tool
    // calls that resolved the field a moment earlier. Leave the live
    // client in place; `buildAgentRegistry` -> `connectHostedTools`
    // adds any new endpoints to the same instance, and stale
    // connections from a removed config become unreachable through
    // the new agent tool indexes (small memory cost, no correctness
    // hazard). The shutdown path still closes — that's process
    // teardown, where in-flight streams have already been aborted via
    // `abortActiveOperations`.
    this.agents = next.agents;
    this.defaultAgentName = next.defaultAgentName;
  }

  /**
   * Builds the agent registry into a fresh `Map` without touching live state.
   * Called by both `setup` and `reload`; the latter only swaps the live
   * registry once this resolves successfully (atomic reload).
   */
  private async buildAgentRegistry(): Promise<{
    agents: Map<string, RegisteredAgent>;
    defaultAgentName: string | null;
  }> {
    const { defs: fileDefs, defaultAgent: fileDefault } =
      await this.loadFileDefinitions();

    const codeDefs = this.config.agents ?? {};

    for (const name of Object.keys(fileDefs)) {
      if (codeDefs[name]) {
        logger.warn(
          "Agent '%s' defined in both code and a markdown file. Code definition takes precedence.",
          name,
        );
      }
    }

    const merged: Record<string, { def: AgentDefinition; src: AgentSource }> =
      {};
    for (const [name, def] of Object.entries(fileDefs)) {
      merged[name] = { def, src: { origin: "file" } };
    }
    for (const [name, def] of Object.entries(codeDefs)) {
      merged[name] = { def, src: { origin: "code" } };
    }

    const agents = new Map<string, RegisteredAgent>();
    let defaultAgentName: string | null = null;

    if (Object.keys(merged).length === 0) {
      logger.info(
        "No agents registered (no files in %s, no code-defined agents)",
        this.resolvedAgentsDir() ?? "<disabled>",
      );
      return { agents, defaultAgentName };
    }

    for (const [name, { def, src }] of Object.entries(merged)) {
      try {
        const registered = await this.buildRegisteredAgent(name, def, src);
        agents.set(name, registered);
        if (!defaultAgentName) defaultAgentName = name;
      } catch (err) {
        throw new Error(
          `Failed to register agent '${name}' (${src.origin}): ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }

    if (this.config.defaultAgent) {
      if (!agents.has(this.config.defaultAgent)) {
        throw new Error(
          `defaultAgent '${this.config.defaultAgent}' is not registered. Available: ${Array.from(agents.keys()).join(", ")}`,
        );
      }
      defaultAgentName = this.config.defaultAgent;
    } else if (fileDefault && agents.has(fileDefault)) {
      defaultAgentName = fileDefault;
    }

    return { agents, defaultAgentName };
  }

  private resolvedAgentsDir(): string | null {
    if (this.config.dir === false) return null;
    const dir = this.config.dir ?? DEFAULT_AGENTS_DIR;
    return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
  }

  private async loadFileDefinitions(): Promise<{
    defs: Record<string, AgentDefinition>;
    defaultAgent: string | null;
  }> {
    const dir = this.resolvedAgentsDir();
    if (!dir) return { defs: {}, defaultAgent: null };

    const pluginToolProviders = this.pluginProviderIndex();
    const ambient = this.config.tools ?? {};

    const result = await loadAgentsFromDir(dir, {
      defaultModel: this.config.defaultModel,
      availableTools: ambient,
      plugins: pluginToolProviders,
      codeAgents: this.config.agents,
    });

    return result;
  }

  /**
   * Builds the map of plugin-name → toolkit that the markdown loader consults
   * when resolving `plugin:NAME` entries in the unified `tools:` frontmatter
   * list (and, equivalently, that the code form passes as the `plugins`
   * argument to `tools(plugins) => Record<...>`).
   */
  private pluginProviderIndex(): Map<
    string,
    { toolkit: (opts?: unknown) => Record<string, unknown> }
  > {
    const out = new Map();
    if (!this.context) return out;
    for (const { name, provider } of this.context.getToolProviders()) {
      const withToolkit = provider as ToolProvider & {
        toolkit?: (opts?: unknown) => Record<string, unknown>;
      };
      if (typeof withToolkit.toolkit === "function") {
        out.set(name, {
          toolkit: withToolkit.toolkit.bind(withToolkit),
        });
      }
    }
    return out;
  }

  private async buildRegisteredAgent(
    name: string,
    def: AgentDefinition,
    src: AgentSource,
  ): Promise<RegisteredAgent> {
    const adapter = await this.resolveAdapter(def, name);
    const toolIndex = await this.buildToolIndex(name, def, src);

    return {
      name,
      instructions: def.instructions,
      adapter,
      toolIndex,
      baseSystemPrompt: def.baseSystemPrompt,
      maxSteps: def.maxSteps,
      maxTokens: def.maxTokens,
      ephemeral: def.ephemeral,
    };
  }

  private async resolveAdapter(
    def: AgentDefinition,
    name: string,
  ): Promise<AgentAdapter> {
    const source = def.model ?? this.config.defaultModel;
    // Per-agent adapter knobs from `AgentDefinition` / markdown frontmatter.
    // Only applied when AppKit builds the adapter itself (string or omitted
    // model). Users who pass a pre-built `AgentAdapter` own these settings.
    const adapterOptions: { maxSteps?: number; maxTokens?: number } = {};
    if (def.maxSteps !== undefined) adapterOptions.maxSteps = def.maxSteps;
    if (def.maxTokens !== undefined) adapterOptions.maxTokens = def.maxTokens;

    if (!source) {
      const { DatabricksAdapter } = await import("../../agents/databricks");
      try {
        return await DatabricksAdapter.fromModelServing(
          undefined,
          adapterOptions,
        );
      } catch (err) {
        throw new Error(
          `Agent '${name}' has no model configured and no DATABRICKS_SERVING_ENDPOINT_NAME default available`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }
    if (typeof source === "string") {
      const { DatabricksAdapter } = await import("../../agents/databricks");
      return DatabricksAdapter.fromModelServing(source, adapterOptions);
    }
    return await source;
  }

  /**
   * Resolves an agent's tool record into a per-agent dispatch index. Connects
   * hosted tools via MCP client. Applies `autoInheritTools` defaults when the
   * definition has no declared tools/agents.
   */
  private async buildToolIndex(
    agentName: string,
    def: AgentDefinition,
    src: AgentSource,
  ): Promise<Map<string, ResolvedToolEntry>> {
    const index = new Map<string, ResolvedToolEntry>();
    const hasDeclaredTools = def.tools !== undefined;
    const toolsRecord = this.resolveDefTools(agentName, def);
    const hasExplicitSubAgents =
      def.agents && Object.keys(def.agents).length > 0;

    const inheritDefaults = normalizeAutoInherit(this.config.autoInheritTools);
    // Declaring `tools` (object or function, even an empty record) opts out
    // of auto-inherit. Same rule for both forms — see plan decision (E1/I1).
    const shouldInherit =
      !hasDeclaredTools &&
      !hasExplicitSubAgents &&
      (src.origin === "file" ? inheritDefaults.file : inheritDefaults.code);

    if (shouldInherit) {
      await this.applyAutoInherit(agentName, index);
    }

    // 1. Sub-agents → agent-<key>
    for (const [childKey, childDef] of Object.entries(def.agents ?? {})) {
      const toolName = `agent-${childKey}`;
      index.set(toolName, {
        source: "subagent",
        agentName: childDef.name ?? childKey,
        def: {
          name: toolName,
          description:
            childDef.instructions.slice(0, 120) ||
            `Delegate to the ${childKey} sub-agent`,
          parameters: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "Message to send to the sub-agent.",
              },
            },
            required: ["input"],
          },
        },
      });
    }

    // 2. Explicit tools (toolkit entries, function tools, hosted tools)
    const hostedToCollect: import("../../core/agent/tools/hosted-tools").HostedTool[] =
      [];
    for (const [key, tool] of Object.entries(toolsRecord)) {
      if (isToolkitEntry(tool)) {
        index.set(key, {
          source: "toolkit",
          pluginName: tool.pluginName,
          localName: tool.localName,
          def: { ...tool.def, name: key },
        });
        continue;
      }
      if (isFunctionTool(tool)) {
        index.set(key, {
          source: "function",
          functionTool: tool,
          def: { ...functionToolToDefinition(tool), name: key },
        });
        continue;
      }
      if (isHostedTool(tool)) {
        hostedToCollect.push(tool);
        continue;
      }
      throw new Error(
        `Agent '${agentName}' tool '${key}' has an unrecognized shape`,
      );
    }

    if (hostedToCollect.length > 0) {
      await this.connectHostedTools(hostedToCollect, index);
    }

    return index;
  }

  /**
   * Resolves an `AgentDefinition.tools` field to a plain tool record. The
   * function form is invoked exactly once at agent setup with the typed
   * {@link Plugins} map; the result replaces the function reference for the
   * remainder of the registered agent's lifetime.
   *
   * Plain object form is returned as-is; an undefined `tools` returns an
   * empty record. The function form is wrapped in a try/catch so a thrown
   * callback fails registration with a useful message instead of leaking
   * the raw stack.
   */
  private resolveDefTools(agentName: string, def: AgentDefinition): AgentTools {
    if (typeof def.tools !== "function") {
      return def.tools ?? {};
    }
    try {
      return def.tools(this.buildPluginsMap());
    } catch (err) {
      throw new Error(
        `Agent '${agentName}': tools(plugins) callback threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }

  /**
   * Builds the typed {@link Plugins} map passed to the function form of
   * `AgentDefinition.tools`. Each entry exposes the plugin instance directly
   * (so user code can call typed instance methods including `.toolkit()`);
   * plugins missing `.toolkit()` get a synthesized fallback that walks
   * `getAgentTools()` via `resolveToolkitFromProvider`.
   *
   * Wrapped in {@link createPluginsProxy} so that accessing an unknown
   * plugin name throws a named "not registered, Available: ..." error
   * instead of bubbling up a generic `Cannot read properties of undefined`
   * from the agent's `tools(plugins)` callback.
   */
  private buildPluginsMap(): Plugins {
    const out: Record<string, PluginToolkitProvider> = {};
    if (!this.context) {
      return createPluginsProxy(out, `Agent '${this.name}': tools(plugins)`);
    }
    for (const { name, provider } of this.context.getToolProviders()) {
      const direct = (provider as { toolkit?: unknown }).toolkit;
      if (typeof direct === "function") {
        out[name] = provider as unknown as PluginToolkitProvider;
      } else {
        out[name] = {
          toolkit: (opts) => resolveToolkitFromProvider(name, provider, opts),
        };
      }
    }
    return createPluginsProxy(out, `Agent '${this.name}': tools(plugins)`);
  }

  private async applyAutoInherit(
    agentName: string,
    index: Map<string, ResolvedToolEntry>,
  ): Promise<void> {
    if (!this.context) return;
    const inherited: string[] = [];
    const skippedByPlugin = new Map<string, string[]>();
    const recordSkip = (pluginName: string, localName: string) => {
      const list = skippedByPlugin.get(pluginName) ?? [];
      list.push(localName);
      skippedByPlugin.set(pluginName, list);
    };

    for (const {
      name: pluginName,
      provider,
    } of this.context.getToolProviders()) {
      if (pluginName === this.name) continue;
      const entries = resolveToolkitFromProvider(pluginName, provider);
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.autoInheritable !== true) {
          recordSkip(entry.pluginName, entry.localName);
          continue;
        }
        index.set(key, {
          source: "toolkit",
          pluginName: entry.pluginName,
          localName: entry.localName,
          def: { ...entry.def, name: key },
        });
        inherited.push(key);
      }
    }

    if (inherited.length > 0) {
      logger.info(
        "[agent %s] auto-inherited %d tool(s): %s",
        agentName,
        inherited.length,
        inherited.join(", "),
      );
    }
    if (skippedByPlugin.size > 0) {
      const summary = Array.from(skippedByPlugin.entries())
        .map(([p, tools]) => `${p}(${tools.length})`)
        .join(", ");
      logger.info(
        "[agent %s] auto-inherit skipped %d tool(s) not marked autoInheritable: %s. Wire them explicitly via `tools:` if needed.",
        agentName,
        Array.from(skippedByPlugin.values()).reduce(
          (n, list) => n + list.length,
          0,
        ),
        summary,
      );
    }
  }

  private async connectHostedTools(
    hostedTools: import("../../core/agent/tools/hosted-tools").HostedTool[],
    index: Map<string, ResolvedToolEntry>,
  ): Promise<void> {
    let host: string | undefined;
    let authenticate: () => Promise<Record<string, string>>;

    try {
      const { getWorkspaceClient } = await import("../../context");
      const wsClient = getWorkspaceClient();
      await wsClient.config.ensureResolved();
      host = wsClient.config.host;
      authenticate = async () => {
        const headers = new Headers();
        await wsClient.config.authenticate(headers);
        return Object.fromEntries(headers.entries());
      };
    } catch {
      host = process.env.DATABRICKS_HOST;
      authenticate = async (): Promise<Record<string, string>> => {
        const token = process.env.DATABRICKS_TOKEN;
        return token ? { Authorization: `Bearer ${token}` } : {};
      };
    }

    if (!host) {
      logger.warn(
        "No Databricks host available — skipping %d hosted tool(s)",
        hostedTools.length,
      );
      return;
    }

    if (!this.mcpClient) {
      const policy = buildMcpHostPolicy(this.config.mcp, host);
      this.mcpClient = new AppKitMcpClient(host, authenticate, policy);
    }

    const endpoints = resolveHostedTools(hostedTools);
    const result = await this.mcpClient.connectAll(endpoints);
    if (result.failed.length > 0) {
      // Per-endpoint errors are already logged inside `connectAll`; this
      // aggregate warning makes the partial-success state visible at the
      // agent-registration boundary so operators see "agent X registered
      // without N hosted-tool endpoints" alongside the connect-time
      // errors, instead of just an opaque list of MCP failures.
      logger.warn(
        "MCP: %s of %s endpoints failed to connect (%s). Agents that reference these endpoints will boot without their hosted tools.",
        result.failed.length,
        endpoints.length,
        result.failed.map((f) => f.name).join(", "),
      );
    }

    for (const def of this.mcpClient.getAllToolDefinitions()) {
      index.set(def.name, {
        source: "mcp",
        mcpToolName: def.name,
        def,
      });
    }
  }

  // ----------------- ToolProvider (no tools of our own) --------------------

  getAgentTools(): AgentToolDefinition[] {
    return [];
  }

  async executeAgentTool(): Promise<unknown> {
    throw new Error("AgentsPlugin does not expose executeAgentTool directly");
  }

  // ----------------- Route mounting and handlers ---------------------------

  /**
   * Mount the non-streaming invoke endpoints outside the `/api/<plugin>`
   * namespace. `/invocations` and `/responses` are aliases — both run the
   * default agent to completion and return a single JSON response. Streaming
   * lives on `POST /chat` (mounted in `injectRoutes`).
   */
  private mountInvokeRoutes() {
    if (!this.context) return;
    const handler = (req: express.Request, res: express.Response) => {
      this._handleInvoke(req, res);
    };
    this.context.addRoute("post", "/invocations", handler);
    this.context.addRoute("post", "/responses", handler);
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "chat",
      method: "post",
      path: "/chat",
      handler: async (req, res) => this._handleChat(req, res),
    });
    this.route(router, {
      name: "cancel",
      method: "post",
      path: "/cancel",
      handler: async (req, res) => this._handleCancel(req, res),
    });
    this.route(router, {
      name: "approve",
      method: "post",
      path: "/approve",
      handler: async (req, res) => this._handleApprove(req, res),
    });
    this.route(router, {
      name: "clientToolResult",
      method: "post",
      path: "/client-tool-result",
      handler: async (req, res) => this._handleClientToolResult(req, res),
    });
    this.route(router, {
      name: "toolChannel",
      method: "get",
      path: "/tool-channel",
      handler: async (req, res) => {
        this._handleToolChannel(req, res);
      },
    });
    this.route(router, {
      name: "registerTools",
      method: "post",
      path: "/register-tools",
      handler: async (req, res) => this._handleRegisterTools(req, res),
    });
    this.mountMcpBridge(router);
    this.route(router, {
      name: "threads",
      method: "get",
      path: "/threads",
      handler: async (req, res) => this._handleListThreads(req, res),
    });
    this.route(router, {
      name: "thread",
      method: "get",
      path: "/threads/:threadId",
      handler: async (req, res) => this._handleGetThread(req, res),
    });
    this.route(router, {
      name: "deleteThread",
      method: "delete",
      path: "/threads/:threadId",
      handler: async (req, res) => this._handleDeleteThread(req, res),
    });
    this.route(router, {
      name: "info",
      method: "get",
      path: "/info",
      handler: async (_req, res) => {
        res.json({
          agents: Array.from(this.agents.keys()),
          defaultAgent: this.defaultAgentName,
        });
      },
    });
  }

  clientConfig(): Record<string, unknown> {
    return {
      agents: Array.from(this.agents.keys()),
      defaultAgent: this.defaultAgentName,
    };
  }

  /**
   * Mount the MCP bridge (`/mcp`) when enabled, exposing the connected tab's UI
   * tools to external MCP clients. Defaults on in development only — it is
   * unauthenticated, so production stays opt-in. All three methods route to the
   * same stateless Streamable HTTP handler.
   */
  private mountMcpBridge(router: IAppRouter): void {
    const enabled =
      this.config.mcpBridge ?? process.env.NODE_ENV === "development";
    if (!enabled) return;

    this.mcpBridge = new McpBridge({
      serverName: "appkit-ui-tools",
      serverVersion: (AgentsPlugin.manifest.version as string) ?? "0.0.0",
      resolveSession: () => {
        const s = this.toolSessions.latest();
        return s
          ? { sessionId: s.sessionId, userId: s.userId, tools: s.tools }
          : null;
      },
      callTool: ({ sessionId, userId, name, args }) =>
        this.deliverClientTool({
          sessionId,
          userId,
          toolName: name,
          toolArgs: args,
          annotations: undefined,
          timeoutMs: this.resolvedLimits.toolCallTimeoutMs,
        }),
    });

    const handler = (req: express.Request, res: express.Response) => {
      this.mcpBridge?.handle(req, res).catch((err) => {
        logger.error("MCP bridge error: %O", err);
        if (!res.headersSent) res.status(500).json({ error: "MCP error" });
      });
    };
    for (const method of ["post", "get", "delete"] as const) {
      this.route(router, {
        name: `mcp-${method}`,
        method,
        path: "/mcp",
        handler: async (req, res) => handler(req, res),
      });
    }
    logger.warn(
      "MCP bridge enabled at /api/%s/mcp — UNAUTHENTICATED. Anyone who can reach this endpoint can drive a connected browser tab. Keep it dev/localhost-only.",
      this.name,
    );
  }

  private async _handleChat(req: express.Request, res: express.Response) {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { message, threadId, agent: agentName, sessionId } = parsed.data;

    const registered = this.resolveAgent(agentName);
    if (!registered) {
      res.status(400).json({
        error: agentName
          ? `Agent "${agentName}" not found`
          : "No agent registered",
      });
      return;
    }

    // The browser's UI tools live in its persistent tool session (registered
    // over the tool channel), not in the chat body. Pull the live catalog for
    // this session so the same registration is shared with the MCP bridge.
    const uiToolEntries = sessionId
      ? (this.toolSessions.get(sessionId)?.tools ?? [])
      : [];

    // Validate the client tool catalog before allocating a thread or stream.
    // Collisions with the agent's static tools (or duplicates) must surface as
    // a synchronous 400 instead of a half-streamed SSE error.
    const catalogError = validateClientToolCatalog(
      uiToolEntries,
      registered.toolIndex,
    );
    if (catalogError) {
      res.status(400).json({ error: catalogError });
      return;
    }

    const userId = this.resolveUserId(req);

    // Reject early (before allocating a thread) when the user is already at
    // their concurrent-stream limit. Prevents a misbehaving client from
    // churning thread rows while being denied elsewhere.
    const limits = this.resolvedLimits;
    if (this.countUserStreams(userId) >= limits.maxConcurrentStreamsPerUser) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({
        error: `Too many concurrent streams for this user (limit ${limits.maxConcurrentStreamsPerUser}). Wait for an existing stream to complete before starting another.`,
      });
      return;
    }

    // ThreadStore can throw on backing-storage failures (DB unreachable,
    // permission errors, transient I/O). Without a try/catch the
    // `async` Express handler bubbles the rejection without a response and
    // the client connection hangs until the proxy times out. Surface the
    // failure as a 500 so the SSE client falls back instead of waiting.
    let thread: Thread;
    try {
      const existing = threadId
        ? await this.threadStore.get(threadId, userId)
        : null;
      if (threadId && !existing) {
        res.status(404).json({ error: `Thread ${threadId} not found` });
        return;
      }
      thread = existing ?? (await this.threadStore.create(userId));

      const userMessage: Message = {
        id: randomUUID(),
        role: "user",
        content: message,
        createdAt: new Date(),
      };
      await this.threadStore.addMessage(thread.id, userId, userMessage);
    } catch (err) {
      logger.error("threadStore failed in /chat: %O", err);
      res.status(500).json({ error: "Thread operation failed" });
      return;
    }
    return this._streamAgent(
      req,
      res,
      registered,
      thread,
      userId,
      uiToolEntries,
      sessionId,
    );
  }

  /**
   * Returns the names of tools in `registered.toolIndex` whose annotations
   * would trip the approval gate. Used by the non-streaming invoke path
   * (`/invocations`, `/responses`) to fail-fast before the adapter runs:
   * those endpoints have no channel back to the user mid-call, so an agent
   * whose tool surface includes approval-gated tools cannot be served.
   *
   * Returns an empty list when the plugin is configured with
   * `approval.requireForDestructive: false` — operators who explicitly
   * disabled HITL keep the invoke surface unrestricted.
   */
  private collectApprovalRequiredToolNames(
    registered: RegisteredAgent,
  ): string[] {
    if (!this.resolvedApprovalPolicy.requireForDestructive) return [];
    const names: string[] = [];
    for (const entry of registered.toolIndex.values()) {
      if (requiresApproval(entry.def.annotations)) {
        names.push(entry.def.name);
      }
    }
    return names;
  }

  /**
   * Shared handler for `POST /invocations` and `POST /responses`. Runs the
   * default agent to completion and returns a single JSON response in the
   * OpenAI Responses non-streaming shape. The two endpoints are aliases —
   * streaming clients must use `POST /chat`.
   *
   * Rejects with HTTP 400 when the resolved agent has any approval-gated
   * tool in scope: HITL requires a live SSE channel, which this surface
   * does not provide. See {@link collectApprovalRequiredToolNames}.
   */
  private async _handleInvoke(req: express.Request, res: express.Response) {
    const parsed = invocationsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { input } = parsed.data;
    const registered = this.resolveAgent();
    if (!registered) {
      res.status(400).json({ error: "No agent registered" });
      return;
    }

    // Pre-flight HITL gate. The non-streaming invoke surface has no way to
    // surface an approval prompt back to the caller and no way to receive
    // a decision mid-run, so we reject up-front instead of having the
    // approval gate auto-deny mid-stream (which would leave the caller
    // with a confusing "denied by user" tool result in the final text).
    const approvalGated = this.collectApprovalRequiredToolNames(registered);
    if (approvalGated.length > 0) {
      res.status(400).json({
        error:
          `Agent '${registered.name}' exposes ${approvalGated.length} approval-gated tool(s) ` +
          `(${approvalGated.join(", ")}); /invocations and /responses are non-streaming and ` +
          "cannot run HITL. Use POST /chat for HITL-capable agents, or disable approval via " +
          "agents({ approval: { requireForDestructive: false } }).",
      });
      return;
    }

    const userId = this.resolveUserId(req);

    // Match the rate-limit gate on /chat. Without this, a client can bypass
    // `limits.maxConcurrentStreamsPerUser` by hitting /invocations instead.
    const limits = this.resolvedLimits;
    if (this.countUserStreams(userId) >= limits.maxConcurrentStreamsPerUser) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({
        error: `Too many concurrent streams for this user (limit ${limits.maxConcurrentStreamsPerUser}). Wait for an existing stream to complete before starting another.`,
      });
      return;
    }

    // Same rationale as `_handleChat`: surface threadStore failures as a
    // 500 instead of letting the async handler hang the client connection.
    let thread: Thread;
    try {
      thread = await this.threadStore.create(userId);

      if (typeof input === "string") {
        await this.threadStore.addMessage(thread.id, userId, {
          id: randomUUID(),
          role: "user",
          content: input,
          createdAt: new Date(),
        });
      } else {
        for (const item of input) {
          const role = (item.role ?? "user") as Message["role"];
          const content =
            typeof item.content === "string"
              ? item.content
              : JSON.stringify(item.content ?? "");
          if (!content) continue;
          await this.threadStore.addMessage(thread.id, userId, {
            id: randomUUID(),
            role,
            content,
            createdAt: new Date(),
          });
        }
      }
    } catch (err) {
      logger.error("threadStore failed in /invocations: %O", err);
      res.status(500).json({ error: "Thread operation failed" });
      return;
    }

    return this._runAgentNonStreaming(req, res, registered, thread, userId);
  }

  private async _streamAgent(
    req: express.Request,
    res: express.Response,
    registered: RegisteredAgent,
    thread: Thread,
    userId: string,
    uiTools: AgentToolDefinition[] = [],
    sessionId?: string,
  ): Promise<void> {
    const abortController = new AbortController();
    const signal = abortController.signal;
    const requestId = randomUUID();
    this.trackStream(requestId, userId, abortController);

    // Per-request tool index: clones the registered agent's static index and
    // augments it with the session's registered UI tools. Mutating
    // `registered.toolIndex` directly would leak request-scoped tools into
    // every subsequent run of the same agent (it's shared across users).
    const requestToolIndex = new Map<string, ResolvedToolEntry>(
      registered.toolIndex,
    );
    for (const def of uiTools) {
      requestToolIndex.set(def.name, { source: "client", def });
    }

    const tools = Array.from(requestToolIndex.values()).map((e) => e.def);
    const approvalPolicy = this.resolvedApprovalPolicy;
    const limits = this.resolvedLimits;
    const outboundEvents = new EventChannel<ResponseStreamEvent>();
    const translator = new AgentEventTranslator();

    // Per-run state shared with any sub-agents this run invokes. The boxed
    // tool-call counter, approval policy, and outbound event channel must
    // travel through the sub-agent path so it enforces the same budget and
    // approval gate as the top-level executeTool.
    const runState: RunState = {
      req,
      userId,
      requestId,
      abortController,
      signal,
      approvalPolicy,
      limits,
      translator,
      outboundEvents,
      toolCallsUsed: { count: 0 },
      sessionId,
      clientCallIds: new Set<string>(),
    };

    const executeTool = (name: string, args: unknown): Promise<unknown> =>
      this.dispatchToolCall(runState, requestToolIndex, name, args, 0);

    // Drive the adapter and the approval-event side-channel concurrently.
    // Outbound events from both sources flow through `outboundEvents`; the
    // generator below drains the channel in order. executeTool pushes
    // approval-pending events into the same channel before awaiting the gate.
    const driver = (async () => {
      try {
        for (const evt of translator.translate({
          type: "metadata",
          data: { threadId: thread.id },
        })) {
          outboundEvents.push(evt);
        }

        const pluginNames = this.context
          ? this.context
              .getPluginNames()
              .filter((n) => n !== this.name && n !== "server")
          : [];
        const fullPrompt = composePromptForAgent(
          registered,
          this.config.baseSystemPrompt,
          {
            agentName: registered.name,
            pluginNames,
            toolNames: tools.map((t) => t.name),
          },
        );

        const messagesWithSystem: Message[] = [
          {
            id: "system",
            role: "system",
            content: fullPrompt,
            createdAt: new Date(),
          },
          ...thread.messages,
        ];

        const stream = registered.adapter.run(
          {
            messages: messagesWithSystem,
            tools,
            threadId: thread.id,
            signal,
          },
          { executeTool, signal },
        );

        // The accumulation rule (deltas append, `message` replaces) is shared
        // with `runAgent` and `runSubAgent`; see `consumeAdapterStream` for
        // the rationale.
        const fullContent = await consumeAdapterStream(stream, {
          signal,
          onEvent: (event) => {
            for (const translated of translator.translate(event)) {
              outboundEvents.push(translated);
            }
          },
        });

        if (fullContent) {
          await this.threadStore.addMessage(thread.id, userId, {
            id: randomUUID(),
            role: "assistant",
            content: fullContent,
            createdAt: new Date(),
          });
        }

        for (const evt of translator.finalize()) outboundEvents.push(evt);
      } catch (error) {
        if (signal.aborted) {
          outboundEvents.close();
          return;
        }
        logger.error("Agent chat error: %O", error);
        outboundEvents.close(error);
        return;
      } finally {
        // Any pending approval gates for this stream are auto-denied so the
        // adapter can unwind if it was still waiting. Client-tool calls are
        // keyed by session (not by this run), so cancel the specific call ids
        // this run spawned rather than aborting by stream id.
        this.approvalGate.abortStream(requestId);
        for (const callId of runState.clientCallIds) {
          this.clientToolGate.cancel(callId);
        }
        this.untrackStream(requestId);
        // Stateless agents (e.g. autocomplete) don't persist history; drop
        // the thread so `InMemoryThreadStore` doesn't accumulate one record
        // per request. Swallow delete errors — the stream has already
        // finished and the client has the response.
        if (registered.ephemeral) {
          try {
            await this.threadStore.delete(thread.id, userId);
          } catch (err) {
            logger.warn(
              "Failed to delete ephemeral thread %s: %O",
              thread.id,
              err,
            );
          }
        }
      }
      outboundEvents.close();
    })();

    await this.executeStream<ResponseStreamEvent>(
      res,
      async function* () {
        try {
          for await (const ev of outboundEvents) {
            yield ev;
          }
        } finally {
          await driver.catch(() => undefined);
        }
      },
      {
        ...agentStreamDefaults,
        stream: { ...agentStreamDefaults.stream, streamId: requestId },
      },
    );
  }

  /**
   * Non-streaming counterpart to {@link _streamAgent} used by `/invocations`
   * and `/responses`. Drives the adapter to completion, persists the
   * assistant turn to the thread store, and returns a single JSON envelope
   * shaped like the OpenAI Responses non-streaming API.
   *
   * No `EventChannel`, no `AgentEventTranslator`, no SSE — the caller is
   * waiting on one HTTP response. The approval gate is force-disabled in
   * the per-run state as defense-in-depth: `_handleInvoke` already rejects
   * up-front if any tool in scope would require approval, but pinning
   * `requireForDestructive: false` here means a tool that somehow slips
   * past the precheck (e.g. annotations mutated at runtime) still won't
   * stall the request waiting for an approval prompt that no one can
   * answer.
   *
   * The `RunState` shape is otherwise unchanged so {@link dispatchToolCall}
   * — including sub-agent recursion via {@link runSubAgent} — keeps the
   * same tool-call budget, abort signal, and timeout enforcement as the
   * streaming path. A still-typed translator is constructed but only
   * consulted for `finalize()` so any in-flight `approval_pending` event
   * synthesis (which would have been a coding bug given the precheck) is
   * a dropped no-op instead of a runtime crash.
   */
  private async _runAgentNonStreaming(
    req: express.Request,
    res: express.Response,
    registered: RegisteredAgent,
    thread: Thread,
    userId: string,
  ): Promise<void> {
    const abortController = new AbortController();
    const signal = abortController.signal;
    const requestId = randomUUID();
    this.trackStream(requestId, userId, abortController);

    const tools = Array.from(registered.toolIndex.values()).map((e) => e.def);
    const limits = this.resolvedLimits;

    const runState: RunState = {
      req,
      userId,
      requestId,
      abortController,
      signal,
      // Force approval off for the non-streaming invoke surface. The
      // precheck in `_handleInvoke` already guarantees no approval-gated
      // tool is reachable; this is belt-and-braces.
      approvalPolicy: { requireForDestructive: false, timeoutMs: 0 },
      limits,
      translator: new AgentEventTranslator(),
      outboundEvents: new EventChannel<ResponseStreamEvent>(),
      toolCallsUsed: { count: 0 },
      // The non-streaming invoke surface has no browser session — no UI tools
      // are reachable here. `sessionId` stays undefined; the `source: "client"`
      // dispatch branch would report "not connected" if one were ever hit.
      clientCallIds: new Set<string>(),
    };

    const executeTool = (name: string, args: unknown): Promise<unknown> =>
      this.dispatchToolCall(runState, registered.toolIndex, name, args, 0);

    let fullContent = "";
    try {
      const pluginNames = this.context
        ? this.context
            .getPluginNames()
            .filter((n) => n !== this.name && n !== "server")
        : [];
      const fullPrompt = composePromptForAgent(
        registered,
        this.config.baseSystemPrompt,
        {
          agentName: registered.name,
          pluginNames,
          toolNames: tools.map((t) => t.name),
        },
      );

      const messagesWithSystem: Message[] = [
        {
          id: "system",
          role: "system",
          content: fullPrompt,
          createdAt: new Date(),
        },
        ...thread.messages,
      ];

      const stream = registered.adapter.run(
        {
          messages: messagesWithSystem,
          tools,
          threadId: thread.id,
          signal,
        },
        { executeTool, signal },
      );

      fullContent = await consumeAdapterStream(stream, { signal });

      if (fullContent) {
        await this.threadStore.addMessage(thread.id, userId, {
          id: randomUUID(),
          role: "assistant",
          content: fullContent,
          createdAt: new Date(),
        });
      }
    } catch (error) {
      if (signal.aborted) {
        res.status(499).json({ error: "Request aborted" });
        return;
      }
      logger.error("Agent invoke error: %O", error);
      const message =
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : error instanceof Error
            ? error.message
            : String(error);
      res.status(500).json({ error: message });
      return;
    } finally {
      this.approvalGate.abortStream(requestId);
      this.untrackStream(requestId);
      if (registered.ephemeral) {
        try {
          await this.threadStore.delete(thread.id, userId);
        } catch (err) {
          logger.warn(
            "Failed to delete ephemeral thread %s: %O",
            thread.id,
            err,
          );
        }
      }
    }

    const responseId = `resp_${randomUUID()}`;
    const messageId = `msg_${randomUUID()}`;
    const message: ResponseOutputMessage = {
      type: "message",
      id: messageId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: fullContent }],
    };
    res.json({
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      thread_id: thread.id,
      output: [message],
    });
  }

  /**
   * Dispatch a single tool call from either the top-level adapter or a
   * sub-agent. Centralising this in one method is what makes the budget
   * counter, approval gate, and abort signal observe sub-agent activity:
   * `runSubAgent` reuses the same `runState` and so increments the same
   * counter and emits approval events through the same channel.
   *
   * `depth` is the current sub-agent recursion depth (0 at the top level).
   * It is forwarded to `runSubAgent` when the dispatched entry is itself a
   * sub-agent, so depth limits remain enforced.
   */
  private async dispatchToolCall(
    runState: RunState,
    toolIndex: Map<string, ResolvedToolEntry>,
    name: string,
    args: unknown,
    depth: number,
  ): Promise<unknown> {
    if (runState.toolCallsUsed.count >= runState.limits.maxToolCalls) {
      runState.abortController.abort(
        new Error(
          `Tool-call budget exhausted (limit ${runState.limits.maxToolCalls}).`,
        ),
      );
      throw new Error(
        `Tool-call budget exhausted (limit ${runState.limits.maxToolCalls}). Raise agents({ limits: { maxToolCalls } }) or review the agent's tool-selection logic.`,
      );
    }
    runState.toolCallsUsed.count++;

    const entry = toolIndex.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);

    if (
      runState.approvalPolicy.requireForDestructive &&
      requiresApproval(entry.def.annotations)
    ) {
      const approvalId = randomUUID();
      for (const ev of runState.translator.translate({
        type: "approval_pending",
        approvalId,
        streamId: runState.requestId,
        toolName: name,
        args,
        annotations: entry.def.annotations,
      })) {
        runState.outboundEvents.push(ev);
      }
      const decision = await this.approvalGate.wait({
        approvalId,
        streamId: runState.requestId,
        userId: runState.userId,
        timeoutMs: runState.approvalPolicy.timeoutMs,
      });
      if (decision === "deny") {
        return `Tool execution denied by user approval gate (tool: ${name}).`;
      }
    }

    let result: unknown;
    if (entry.source === "toolkit") {
      if (!this.context) {
        throw new Error(
          "Plugin tool execution requires PluginContext; this should never happen through createApp",
        );
      }
      result = await this.context.executeTool(
        runState.req,
        entry.pluginName,
        entry.localName,
        args,
        runState.signal,
        runState.limits.toolCallTimeoutMs,
      );
    } else if (entry.source === "function") {
      // Function tools declare their parameters as a JSON-object schema,
      // so adapters always serialize `args` as an object. A non-object
      // value here means the upstream model emitted malformed tool-call
      // JSON; surface a clear error rather than silently passing through
      // a wrong-shape value the tool will then choke on.
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error(
          `Function tool '${name}' received non-object arguments (got ${args === null ? "null" : Array.isArray(args) ? "array" : typeof args}); expected a JSON object.`,
        );
      }
      result = await entry.functionTool.execute(
        args as Record<string, unknown>,
      );
    } else if (entry.source === "mcp") {
      if (!this.mcpClient) throw new Error("MCP client not connected");
      const oboToken = runState.req.headers["x-forwarded-access-token"];
      const mcpAuth =
        typeof oboToken === "string"
          ? { Authorization: `Bearer ${oboToken}` }
          : undefined;
      result = await this.mcpClient.callTool(entry.mcpToolName, args, mcpAuth);
    } else if (entry.source === "subagent") {
      const childAgent = this.agents.get(entry.agentName);
      if (!childAgent)
        throw new Error(`Sub-agent not found: ${entry.agentName}`);
      result = await this.runSubAgent(runState, childAgent, args, depth + 1);
    } else if (entry.source === "client") {
      // Round-trip to the browser over its persistent tool channel (shared
      // with the MCP bridge), not the chat SSE stream. `deliverClientTool`
      // already normalizes the result and turns timeouts/aborts/browser
      // failures into a sanitised string for the LLM, so return directly.
      return this.deliverClientTool({
        sessionId: runState.sessionId,
        userId: runState.userId,
        toolName: name,
        toolArgs: args,
        annotations: entry.def.annotations,
        timeoutMs: runState.limits.toolCallTimeoutMs,
        signal: runState.signal,
        callIds: runState.clientCallIds,
      });
    }

    return normalizeToolResult(result);
  }

  /**
   * Runs a sub-agent in response to an `agent-<key>` tool call. Returns the
   * concatenated text output to hand back to the parent adapter as the tool
   * result.
   *
   * `depth` starts at 1 for a top-level sub-agent invocation (i.e. the
   * outer `_streamAgent` calls `runSubAgent(..., 1)`) and increments on
   * each nested `runSubAgent` call. Depths exceeding
   * `limits.maxSubAgentDepth` are rejected before any adapter work.
   *
   * Sub-agent tool calls run through `dispatchToolCall` with the same
   * `runState` as the parent — the budget counter and approval gate are
   * therefore enforced for every nested call, not only at the top level.
   */
  private async runSubAgent(
    runState: RunState,
    child: RegisteredAgent,
    args: unknown,
    depth: number,
  ): Promise<string> {
    if (depth > runState.limits.maxSubAgentDepth) {
      throw new Error(
        `Sub-agent depth exceeded (limit ${runState.limits.maxSubAgentDepth}). ` +
          `Raise agents({ limits: { maxSubAgentDepth } }) or break the delegation cycle.`,
      );
    }

    const input =
      typeof args === "object" &&
      args !== null &&
      typeof (args as { input?: unknown }).input === "string"
        ? (args as { input: string }).input
        : JSON.stringify(args);
    const childTools = Array.from(child.toolIndex.values()).map((e) => e.def);

    const childExecute = (name: string, childArgs: unknown): Promise<unknown> =>
      this.dispatchToolCall(runState, child.toolIndex, name, childArgs, depth);

    const runContext: AgentRunContext = {
      executeTool: childExecute,
      signal: runState.signal,
    };

    const pluginNames = this.context
      ? this.context
          .getPluginNames()
          .filter((n) => n !== this.name && n !== "server")
      : [];
    const systemPrompt = composePromptForAgent(
      child,
      this.config.baseSystemPrompt,
      {
        agentName: child.name,
        pluginNames,
        toolNames: childTools.map((t) => t.name),
      },
    );

    const messages: Message[] = [
      {
        id: "system",
        role: "system",
        content: systemPrompt,
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        role: "user",
        content: input,
        createdAt: new Date(),
      },
    ];

    return consumeAdapterStream(
      child.adapter.run(
        {
          messages,
          tools: childTools,
          threadId: randomUUID(),
          signal: runState.signal,
        },
        runContext,
      ),
      {
        signal: runState.signal,
        // Forward every sub-agent event into the parent's outbound SSE
        // stream so the client sees nested tool_call / tool_result events
        // (UI-action tools like apply_filter / highlight_period rely on
        // this) and the sub-agent's streaming text as it's generated.
        //
        // `metadata` is the one exception: sub-agents have their own
        // threadId, and forwarding it would overwrite the parent's
        // thread state on the client and break multi-turn continuity.
        // Approval-pending events emitted by `dispatchToolCall` already
        // reach `outboundEvents` directly, so they are not routed here.
        onEvent: (event) => {
          if (event.type === "metadata") return;
          for (const translated of runState.translator.translate(event)) {
            runState.outboundEvents.push(translated);
          }
        },
      },
    );
  }

  private async _handleCancel(req: express.Request, res: express.Response) {
    const parsed = cancelRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { streamId } = parsed.data;
    const entry = this.activeStreams.get(streamId);
    if (!entry) {
      // Stream is unknown or already completed — idempotent no-op.
      res.json({ cancelled: true });
      return;
    }
    const userId = this.resolveUserId(req);
    if (entry.userId !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    entry.controller.abort("Cancelled by user");
    this.untrackStream(streamId);
    this.approvalGate.abortStream(streamId);
    res.json({ cancelled: true });
  }

  private async _handleApprove(req: express.Request, res: express.Response) {
    const parsed = approvalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { streamId, approvalId, decision } = parsed.data;

    const streamEntry = this.activeStreams.get(streamId);
    if (!streamEntry) {
      // Stream has already completed or never existed. Return 404 so the UI
      // knows the approval token is no longer valid (the waiter, if any, has
      // already been timed out or aborted).
      res.status(404).json({ error: "Stream not found or already completed" });
      return;
    }

    const userId = this.resolveUserId(req);
    if (streamEntry.userId !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const result = this.approvalGate.submit({ approvalId, userId, decision });
    if (!result.ok) {
      if (result.reason === "forbidden") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(404).json({ error: "Approval not found or already settled" });
      return;
    }

    res.json({ decision });
  }

  private async _handleClientToolResult(
    req: express.Request,
    res: express.Response,
  ) {
    const parsed = clientToolResultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { callId, result, error } = parsed.data;

    // Unified settlement: calls are keyed by callId on the gate, regardless of
    // whether they were initiated by the in-app chat agent or the MCP bridge,
    // so there is no chat-stream lookup here. The gate verifies the userId
    // matches the one captured when the call was issued.
    const userId = this.resolveUserId(req);
    const outcome =
      typeof error === "string"
        ? ({ kind: "error", error } as const)
        : ({ kind: "ok", result } as const);

    const submitted = this.clientToolGate.submit({ callId, userId, outcome });
    if (!submitted.ok) {
      if (submitted.reason === "forbidden") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res
        .status(404)
        .json({ error: "Client tool call not found or already settled" });
      return;
    }

    res.json({ ok: true });
  }

  /**
   * Persistent SSE channel a browser tab holds open for the lifetime of the
   * page. The server pushes `client_tool_call` events down it (from the in-app
   * agent or the MCP bridge); the tab POSTs outcomes to `/client-tool-result`.
   * Raw SSE (not `executeStream`) because this is an unbounded channel that the
   * stream interceptors' timeout would otherwise tear down.
   */
  private _handleToolChannel(req: express.Request, res: express.Response) {
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId : null;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId query param is required" });
      return;
    }
    const userId = this.resolveUserId(req);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    res.flushHeaders?.();

    const push = (event: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    this.toolSessions.openChannel(sessionId, userId, push);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      this.toolSessions.closeChannel(sessionId);
      // Cancel any UI tool calls still waiting on this tab.
      this.clientToolGate.abortStream(sessionId);
    });
  }

  /**
   * Browser pushes its live UI-tool catalog for a session. Replaces the
   * per-request `uiTools` body; the catalog persists until re-registered or the
   * tab disconnects, and is shared by the chat agent and the MCP bridge.
   */
  private async _handleRegisterTools(
    req: express.Request,
    res: express.Response,
  ) {
    const parsed = registerToolsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { sessionId, tools } = parsed.data;
    const userId = this.resolveUserId(req);
    this.toolSessions.setTools(
      sessionId,
      userId,
      tools as AgentToolDefinition[],
    );
    res.json({ ok: true, count: tools.length });
  }

  /**
   * Round-trip a single UI-tool call to a browser tab over its session
   * channel and await the outcome on the shared gate. Used by both the in-app
   * agent's dispatch and (Phase 2) the MCP bridge. Never throws — timeouts,
   * aborts, and missing channels surface as a structured error string.
   */
  private async deliverClientTool(args: {
    sessionId: string | undefined;
    userId: string;
    toolName: string;
    toolArgs: unknown;
    annotations: ToolAnnotations | undefined;
    timeoutMs: number;
    signal?: AbortSignal;
    callIds?: Set<string>;
  }): Promise<unknown> {
    const { sessionId, userId, toolName, toolArgs, annotations, timeoutMs } =
      args;
    const session = sessionId ? this.toolSessions.get(sessionId) : undefined;
    if (!session?.push) {
      return `Client tool '${toolName}' could not be delivered: the browser tab is not connected.`;
    }

    const callId = randomUUID();
    args.callIds?.add(callId);
    session.push({
      type: "appkit.client_tool_call",
      call_id: callId,
      stream_id: sessionId,
      tool_name: toolName,
      args: toolArgs,
      annotations,
    });

    const onAbort = () => this.clientToolGate.cancel(callId);
    args.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const outcome = await this.clientToolGate.wait({
        callId,
        streamId: sessionId as string,
        userId,
        toolName,
        timeoutMs,
      });
      if (outcome.kind === "error") {
        return `Client tool '${toolName}' failed: ${outcome.error}`;
      }
      return normalizeToolResult(outcome.result);
    } finally {
      args.signal?.removeEventListener("abort", onAbort);
      args.callIds?.delete(callId);
    }
  }

  private async _handleListThreads(
    req: express.Request,
    res: express.Response,
  ) {
    const userId = this.resolveUserId(req);
    const threads = await this.threadStore.list(userId);
    res.json({ threads });
  }

  private async _handleGetThread(req: express.Request, res: express.Response) {
    const userId = this.resolveUserId(req);
    const thread = await this.threadStore.get(req.params.threadId, userId);
    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    res.json(thread);
  }

  private async _handleDeleteThread(
    req: express.Request,
    res: express.Response,
  ) {
    const userId = this.resolveUserId(req);
    const deleted = await this.threadStore.delete(req.params.threadId, userId);
    if (!deleted) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    res.json({ deleted: true });
  }

  private resolveAgent(name?: string): RegisteredAgent | null {
    if (name) return this.agents.get(name) ?? null;
    if (this.defaultAgentName) {
      return this.agents.get(this.defaultAgentName) ?? null;
    }
    const first = this.agents.values().next();
    return first.done ? null : first.value;
  }

  private printRegistry(): void {
    if (this.agents.size === 0) return;
    console.log("");
    console.log(`  ${pc.bold("Agents")} ${pc.dim(`(${this.agents.size})`)}`);
    console.log(`  ${pc.dim("─".repeat(60))}`);
    for (const [name, reg] of this.agents) {
      const tools = reg.toolIndex.size;
      const marker = name === this.defaultAgentName ? pc.green("●") : " ";
      console.log(
        `  ${marker} ${pc.bold(name.padEnd(24))} ${pc.dim(`${tools} tools`)}`,
      );
    }
    console.log(`  ${pc.dim("─".repeat(60))}`);
    console.log("");
  }

  async shutdown(): Promise<void> {
    this.approvalGate.abortAll();
    this.clientToolGate.abortAll();
    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
    }
  }

  exports() {
    return {
      register: (name: string, def: AgentDefinition) =>
        this.registerCodeAgent(name, def),
      list: () => Array.from(this.agents.keys()),
      get: (name: string) => this.agents.get(name) ?? null,
      reload: () => this.reload(),
      getDefault: () => this.defaultAgentName,
      getThreads: (userId: string) => this.threadStore.list(userId),
    };
  }

  private async registerCodeAgent(
    name: string,
    def: AgentDefinition,
  ): Promise<void> {
    const registered = await this.buildRegisteredAgent(name, def, {
      origin: "code",
    });
    this.agents.set(name, registered);
    if (!this.defaultAgentName) this.defaultAgentName = name;
  }
}

function normalizeAutoInherit(value: AgentsPluginConfig["autoInheritTools"]): {
  file: boolean;
  code: boolean;
} {
  // Default is opt-out for both origins. A markdown agent or code-defined
  // agent with no declared `tools:` gets an empty tool index unless the
  // developer explicitly flips `autoInheritTools` on. Even then, only tools
  // whose plugin author marked `autoInheritable: true` are spread — see
  // `applyAutoInherit` for the filter.
  if (value === undefined) return { file: false, code: false };
  if (typeof value === "boolean") return { file: value, code: value };
  return { file: value.file ?? false, code: value.code ?? false };
}

function composePromptForAgent(
  registered: RegisteredAgent,
  pluginLevel: BaseSystemPromptOption | undefined,
  ctx: PromptContext,
): string {
  const perAgent = registered.baseSystemPrompt;
  const resolved = perAgent !== undefined ? perAgent : pluginLevel;

  let base = "";
  if (resolved === false) {
    base = "";
  } else if (typeof resolved === "string") {
    base = resolved;
  } else if (typeof resolved === "function") {
    base = resolved(ctx);
  } else {
    base = buildBaseSystemPrompt(ctx);
  }

  return composeSystemPrompt(base, registered.instructions);
}

/**
 * Plugin factory for the agents plugin. Reads `config/agents/*.md` by default,
 * resolves toolkits/tools from registered plugins, exposes `appkit.agents.*`
 * runtime API and mounts `POST /invocations` and `POST /responses` (aliased
 * non-streaming invoke endpoints) plus `POST /chat` (streaming, HITL-capable).
 *
 * @example
 * ```ts
 * import { agents, analytics, createApp, server } from "@databricks/appkit";
 *
 * await createApp({
 *   plugins: [server(), analytics(), agents()],
 * });
 * ```
 */
export const agents = toPlugin(AgentsPlugin);
