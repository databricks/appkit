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
  ToolProvider,
} from "shared";
import { AppKitMcpClient, buildMcpHostPolicy } from "../../connectors/mcp";
import { getWorkspaceClient } from "../../context";
import { consumeAdapterStream } from "../../core/agent/consume-adapter-stream";
import { isFromPluginMarker } from "../../core/agent/from-plugin";
import { loadAgentsFromDir } from "../../core/agent/load-agents";
import { AgentRunner } from "../../core/agent/runner";
import { dispatchToolCall } from "../../core/agent/tool-dispatch";
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
import {
  type ApprovalCheck,
  HttpToolExecutor,
  type ToolBudget,
} from "./http-tool-executor";
import manifest from "./manifest.json";
import { composePromptForAgent, normalizeAutoInherit } from "./prompt";
import { printRegistry } from "./registry-printer";
import {
  approvalRequestSchema,
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

export class AgentsPlugin extends Plugin implements ToolProvider {
  static manifest = manifest as PluginManifest;
  static phase: PluginPhase = "deferred";

  protected declare config: AgentsPluginConfig;

  /** @internal - Mutated by route handlers and tool-execution helpers. */
  agents = new Map<string, RegisteredAgent>();
  /** @internal */
  defaultAgentName: string | null = null;
  /** @internal */
  activeStreams = new Map<
    string,
    { controller: AbortController; userId: string }
  >();
  /** @internal */
  mcpClient: AppKitMcpClient | null = null;
  /** @internal */
  threadStore;
  /** @internal */
  approvalGate = new ToolApprovalGate();

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

  /** Effective approval policy with defaults applied. @internal */
  get resolvedApprovalPolicy(): {
    requireForDestructive: boolean;
    timeoutMs: number;
  } {
    const cfg = this.config.approval ?? {};
    return {
      requireForDestructive: cfg.requireForDestructive ?? true,
      timeoutMs: cfg.timeoutMs ?? 60_000,
    };
  }

  /** Effective DoS limits with defaults applied. @internal */
  get resolvedLimits(): {
    maxConcurrentStreamsPerUser: number;
    maxToolCalls: number;
    maxSubAgentDepth: number;
  } {
    const cfg = this.config.limits ?? {};
    return {
      maxConcurrentStreamsPerUser: cfg.maxConcurrentStreamsPerUser ?? 5,
      maxToolCalls: cfg.maxToolCalls ?? 50,
      maxSubAgentDepth: cfg.maxSubAgentDepth ?? 3,
    };
  }

  /** Count active streams owned by a given user. @internal */
  countUserStreams(userId: string): number {
    let n = 0;
    for (const entry of this.activeStreams.values()) {
      if (entry.userId === userId) n++;
    }
    return n;
  }

  async setup() {
    await this.loadAgents();
    this.mountInvocationsRoute();
    printRegistry(this.agents, this.defaultAgentName);
  }

  /**
   * Reload agents from the configured directory, preserving code-defined
   * agents. Swaps the registry atomically at the end.
   */
  async reload(): Promise<void> {
    this.agents.clear();
    this.defaultAgentName = null;
    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
    }
    await this.loadAgents();
  }

  private async loadAgents() {
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

    if (Object.keys(merged).length === 0) {
      logger.info(
        "No agents registered (no files in %s, no code-defined agents)",
        this.resolvedAgentsDir() ?? "<disabled>",
      );
      return;
    }

    for (const [name, { def, src }] of Object.entries(merged)) {
      try {
        const registered = await this.buildRegisteredAgent(name, def, src);
        this.agents.set(name, registered);
        if (!this.defaultAgentName) this.defaultAgentName = name;
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
      if (!this.agents.has(this.config.defaultAgent)) {
        throw new Error(
          `defaultAgent '${this.config.defaultAgent}' is not registered. Available: ${Array.from(this.agents.keys()).join(", ")}`,
        );
      }
      this.defaultAgentName = this.config.defaultAgent;
    } else if (fileDefault && this.agents.has(fileDefault)) {
      this.defaultAgentName = fileDefault;
    }
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
   * when resolving `toolkits:` frontmatter entries.
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
    const toolsRecord = def.tools ?? {};
    const hasExplicitTools =
      def.tools !== undefined &&
      (Object.keys(toolsRecord).length > 0 ||
        Object.getOwnPropertySymbols(toolsRecord).length > 0);
    const hasExplicitSubAgents =
      def.agents && Object.keys(def.agents).length > 0;

    const inheritDefaults = normalizeAutoInherit(this.config.autoInheritTools);
    const shouldInherit =
      !hasExplicitTools &&
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

    // 2. fromPlugin markers — resolve against registered ToolProviders first so
    //    explicit string-keyed tools can still overwrite on the same key.
    this.resolveFromPluginMarkers(agentName, toolsRecord, index);

    // 3. Explicit tools (toolkit entries, function tools, hosted tools)
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

  /**
   * Walks the symbol-keyed `fromPlugin` markers in an agent's `tools` record
   * and resolves each one against a registered `ToolProvider`. Throws with a
   * helpful `Available: …` listing if a referenced plugin isn't registered.
   */
  private resolveFromPluginMarkers(
    agentName: string,
    toolsRecord: Record<string | symbol, unknown>,
    index: Map<string, ResolvedToolEntry>,
  ): void {
    const symbolKeys = Object.getOwnPropertySymbols(toolsRecord);
    if (symbolKeys.length === 0) return;

    const providers = this.context?.getToolProviders() ?? [];

    for (const sym of symbolKeys) {
      const marker = (toolsRecord as Record<symbol, unknown>)[sym];
      if (!isFromPluginMarker(marker)) continue;

      const providerEntry = providers.find((p) => p.name === marker.pluginName);
      if (!providerEntry) {
        const available = providers.map((p) => p.name).join(", ") || "(none)";
        throw new Error(
          `Agent '${agentName}' references plugin '${marker.pluginName}' via ` +
            `fromPlugin(), but that plugin is not registered in createApp. ` +
            `Available: ${available}.`,
        );
      }

      const entries = resolveToolkitFromProvider(
        marker.pluginName,
        providerEntry.provider,
        marker.opts,
      );
      for (const [key, entry] of Object.entries(entries)) {
        index.set(key, {
          source: "toolkit",
          pluginName: entry.pluginName,
          localName: entry.localName,
          def: { ...entry.def, name: key },
        });
      }
    }
  }

  private async connectHostedTools(
    hostedTools: import("../../core/agent/tools/hosted-tools").HostedTool[],
    index: Map<string, ResolvedToolEntry>,
  ): Promise<void> {
    const wsClient = await this.resolveWorkspaceClient();
    await wsClient.config.ensureResolved();
    const host = wsClient.config.host;

    if (!host) {
      logger.warn(
        "No Databricks host available — skipping %d hosted tool(s). " +
          "Set DATABRICKS_HOST or configure a profile in ~/.databrickscfg.",
        hostedTools.length,
      );
      return;
    }

    const authenticate = async (): Promise<Record<string, string>> => {
      const headers = new Headers();
      await wsClient.config.authenticate(headers);
      return Object.fromEntries(headers.entries());
    };

    if (!this.mcpClient) {
      const policy = buildMcpHostPolicy(this.config.mcp, host);
      this.mcpClient = new AppKitMcpClient(host, authenticate, policy);
    }

    const endpoints = resolveHostedTools(hostedTools);
    await this.mcpClient.connectAll(endpoints);

    for (const def of this.mcpClient.getAllToolDefinitions()) {
      index.set(def.name, {
        source: "mcp",
        mcpToolName: def.name,
        def,
      });
    }
  }

  /**
   * Return the ambient workspace client from {@link getWorkspaceClient} when
   * `ServiceContext` is initialized (the normal `createApp` path). Fall back
   * to a fresh `WorkspaceClient()` that walks the SDK's credential chain —
   * `DATABRICKS_HOST` / `DATABRICKS_TOKEN`, `~/.databrickscfg` profiles,
   * DAB auth, OAuth, metadata service — for test rigs and manual embeds
   * that never ran through `createApp`.
   */
  private async resolveWorkspaceClient() {
    try {
      return getWorkspaceClient();
    } catch {
      const { WorkspaceClient } = await import("@databricks/sdk-experimental");
      return new WorkspaceClient({});
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

    let thread = threadId ? await this.threadStore.get(threadId, userId) : null;
    if (threadId && !thread) {
      res.status(404).json({ error: `Thread ${threadId} not found` });
      return;
    }
    if (!thread) {
      thread = await this.threadStore.create(userId);
    }

    const userMessage: Message = {
      id: randomUUID(),
      role: "user",
      content: message,
      createdAt: new Date(),
    };
    await this.threadStore.addMessage(thread.id, userId, userMessage);
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
    const thread = await this.threadStore.create(userId);

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
    this.activeStreams.set(requestId, { controller: abortController, userId });

    const tools = Array.from(registered.toolIndex.values()).map((e) => e.def);
    const limits = this.resolvedLimits;
    const outboundEvents = new EventChannel<ResponseStreamEvent>();
    const translator = new AgentEventTranslator();
    // Per-run tool-call budget shared across the top-level adapter and any
    // sub-agents it delegates to. Counted pre-dispatch so a prompt-injected
    // agent cannot drain the budget silently via denied calls.
    const budget: ToolBudget = { used: 0, limit: limits.maxToolCalls };

    const executor = new HttpToolExecutor({
      toolIndex: registered.toolIndex,
      approvalPolicy: this.resolvedApprovalPolicy,
      approvalGate: this.approvalGate,
      translator,
      outboundEvents,
      abortController,
      budget,
      req,
      streamId: requestId,
      userId,
      pluginContext: this.context,
      mcpClient: this.mcpClient,
      runSubAgent: (agentName, subArgs, subSignal, forwardEvent, check) => {
        const childAgent = this.agents.get(agentName);
        if (!childAgent) throw new Error(`Sub-agent not found: ${agentName}`);
        return this.runSubAgent(
          req,
          childAgent,
          subArgs,
          subSignal,
          1,
          forwardEvent,
          check,
        );
      },
    });

    const runner = new AgentRunner({
      adapter: registered.adapter,
      tools,
      executeTool: executor,
      signal,
      onEvent: (event) => {
        for (const translated of translator.translate(event)) {
          outboundEvents.push(translated);
        }
      },
    });

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

        const fullContent = await runner.run({
          messages: messagesWithSystem,
          threadId: thread.id,
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
        this.activeStreams.delete(requestId);
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
   * Runs a sub-agent in response to an `agent-<key>` tool call. Returns the
   * concatenated text output to hand back to the parent adapter as the tool
   * result.
   *
   * `depth` starts at 1 for a top-level sub-agent invocation (i.e. the
   * outer `_streamAgent` calls `runSubAgent(..., 1)`) and increments on
   * each nested `runSubAgent` call. Depths exceeding
   * `limits.maxSubAgentDepth` are rejected before any adapter work.
   */
  private async runSubAgent(
    req: express.Request,
    child: RegisteredAgent,
    args: unknown,
    signal: AbortSignal,
    depth: number,
    /**
     * Optional per-event sink installed by the parent `_streamAgent`. When
     * supplied, each adapter event the child yields is passed through —
     * the parent's closure forwards everything except `metadata` so the
     * sub-agent's streaming text, tool invocations, and thinking blocks
     * all surface to the client's SSE stream in real time.
     */
    onEvent?: (event: AgentEvent) => void,
    /**
     * Optional approval gate injected by the parent `_streamAgent`. When
     * present, sub-agent tool calls annotated `destructive: true` fire
     * `appkit.approval_pending` through the parent's outbound channel and
     * await the user's decision, exactly like the parent's own executeTool.
     * Absent (or returning `null`) means no gate — non-destructive tools
     * or approval disabled policy-wide.
     */
    checkApproval?: ApprovalCheck,
  ): Promise<string> {
    const limits = this.resolvedLimits;
    if (depth > limits.maxSubAgentDepth) {
      throw new Error(
        `Sub-agent depth exceeded (limit ${limits.maxSubAgentDepth}). ` +
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

    // Sub-agent dispatch reuses the parent's approval check so a destructive
    // tool fires `approval_pending` on the parent's SSE stream. Sub-agents
    // do not enforce their own budget — the parent already counted the
    // `agent-<key>` invocation.
    const childExecute = async (
      name: string,
      childArgs: unknown,
    ): Promise<unknown> => {
      const entry = child.toolIndex.get(name);
      if (!entry) throw new Error(`Unknown tool in sub-agent: ${name}`);

      if (checkApproval) {
        const decision = await checkApproval(entry, childArgs);
        if (decision === "deny") {
          return `Tool execution denied by user approval gate (tool: ${name}).`;
        }
      }

      return dispatchToolCall(entry, childArgs, {
        req,
        signal,
        pluginContext: this.context,
        mcpClient: this.mcpClient,
        runSubAgent: (agentName, args) => {
          const grandchild = this.agents.get(agentName);
          if (!grandchild) throw new Error(`Sub-agent not found: ${agentName}`);
          return this.runSubAgent(
            req,
            grandchild,
            args,
            signal,
            depth + 1,
            onEvent,
            checkApproval,
          );
        },
      });
    };

    const runContext: AgentRunContext = { executeTool: childExecute, signal };

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
        { messages, tools: childTools, threadId: randomUUID(), signal },
        runContext,
      ),
      { signal, onEvent },
    );
  }

  private async _handleCancel(req: express.Request, res: express.Response) {
    const { streamId } = req.body as { streamId?: string };
    if (!streamId) {
      res.status(400).json({ error: "streamId is required" });
      return;
    }
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
    this.activeStreams.delete(streamId);
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

/**
 * Plugin factory for the agents plugin. Reads `config/agents/<id>/agent.md` by default,
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
