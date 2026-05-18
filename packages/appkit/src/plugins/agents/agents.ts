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
import { isToolkitEntry } from "../../core/agent/types";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { agentStreamDefaults } from "./defaults";
import { EventChannel } from "./event-channel";
import { AgentEventTranslator } from "./event-translator";
import manifest from "./manifest.json";
import {
  approvalRequestSchema,
  cancelRequestSchema,
  chatRequestSchema,
  invocationsRequestSchema,
} from "./schemas";
import { InMemoryThreadStore } from "./thread-store";
import { ToolApprovalGate } from "./tool-approval-gate";

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
    this.mountInvocationsRoute();
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

  private mountInvocationsRoute() {
    if (!this.context) return;
    this.context.addRoute(
      "post",
      "/invocations",
      (req: express.Request, res: express.Response) => {
        this._handleInvocations(req, res);
      },
    );
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

  private async _handleChat(req: express.Request, res: express.Response) {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { message, threadId, agent: agentName } = parsed.data;

    const registered = this.resolveAgent(agentName);
    if (!registered) {
      res.status(400).json({
        error: agentName
          ? `Agent "${agentName}" not found`
          : "No agent registered",
      });
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
    return this._streamAgent(req, res, registered, thread, userId);
  }

  private async _handleInvocations(
    req: express.Request,
    res: express.Response,
  ) {
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

    return this._streamAgent(req, res, registered, thread, userId);
  }

  private async _streamAgent(
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
    };

    const executeTool = (name: string, args: unknown): Promise<unknown> =>
      this.dispatchToolCall(runState, registered.toolIndex, name, args, 0);

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
        // adapter can unwind if it was still waiting.
        this.approvalGate.abortStream(requestId);
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
 * runtime API and mounts `/invocations`.
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
