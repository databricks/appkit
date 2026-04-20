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
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { agentStreamDefaults } from "../agent/defaults";
import { AgentEventTranslator } from "../agent/event-translator";
import { chatRequestSchema, invocationsRequestSchema } from "../agent/schemas";
import {
  buildBaseSystemPrompt,
  composeSystemPrompt,
} from "../agent/system-prompt";
import { InMemoryThreadStore } from "../agent/thread-store";
import {
  AppKitMcpClient,
  type FunctionTool,
  functionToolToDefinition,
  isFunctionTool,
  isHostedTool,
  resolveHostedTools,
} from "../agent/tools";
import { loadAgentsFromDir } from "./load-agents";
import manifest from "./manifest.json";
import type {
  AgentDefinition,
  AgentsPluginConfig,
  BaseSystemPromptOption,
  PromptContext,
  RegisteredAgent,
  ResolvedToolEntry,
} from "./types";
import { isToolkitEntry } from "./types";

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

  private agents = new Map<string, RegisteredAgent>();
  private defaultAgentName: string | null = null;
  private activeStreams = new Map<string, AbortController>();
  private mcpClient: AppKitMcpClient | null = null;
  private threadStore;

  constructor(config: AgentsPluginConfig) {
    super(config);
    this.config = config;
    this.threadStore = config.threadStore ?? new InMemoryThreadStore();
  }

  async setup() {
    await this.loadAgents();
    this.mountInvocationsRoute();
    this.printRegistry();
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
    };
  }

  private async resolveAdapter(
    def: AgentDefinition,
    name: string,
  ): Promise<AgentAdapter> {
    const source = def.model ?? this.config.defaultModel;
    if (!source) {
      const { DatabricksAdapter } = await import("../../agents/databricks");
      try {
        return await DatabricksAdapter.fromModelServing();
      } catch (err) {
        throw new Error(
          `Agent '${name}' has no model configured and no DATABRICKS_AGENT_ENDPOINT default available`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }
    if (typeof source === "string") {
      const { DatabricksAdapter } = await import("../../agents/databricks");
      return DatabricksAdapter.fromModelServing(source);
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
    const hasExplicitTools = def.tools && Object.keys(def.tools).length > 0;
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

    // 2. Explicit tools (toolkit entries, function tools, hosted tools)
    const hostedToCollect: import("../agent/tools/hosted-tools").HostedTool[] =
      [];
    for (const [key, tool] of Object.entries(def.tools ?? {})) {
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
    for (const {
      name: pluginName,
      provider,
    } of this.context.getToolProviders()) {
      if (pluginName === this.name) continue;
      const withToolkit = provider as ToolProvider & {
        toolkit?: (opts?: unknown) => Record<string, unknown>;
      };
      if (typeof withToolkit.toolkit === "function") {
        const entries = withToolkit.toolkit() as Record<string, unknown>;
        for (const [key, maybeEntry] of Object.entries(entries)) {
          if (!isToolkitEntry(maybeEntry)) continue;
          index.set(key, {
            source: "toolkit",
            pluginName: maybeEntry.pluginName,
            localName: maybeEntry.localName,
            def: { ...maybeEntry.def, name: key },
          });
        }
        continue;
      }
      // Fallback: providers without a toolkit() still expose getAgentTools();
      // dispatch goes through PluginContext.executeTool by plugin name.
      for (const tool of provider.getAgentTools()) {
        const qualifiedName = `${pluginName}.${tool.name}`;
        index.set(qualifiedName, {
          source: "toolkit",
          pluginName,
          localName: tool.name,
          def: { ...tool, name: qualifiedName },
        });
      }
    }
    const aliased = Array.from(index.keys());
    if (aliased.length > 0) {
      logger.info(
        "[agent %s] auto-inherited %d tools",
        agentName,
        aliased.length,
      );
    }
  }

  private async connectHostedTools(
    hostedTools: import("../agent/tools/hosted-tools").HostedTool[],
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
      this.mcpClient = new AppKitMcpClient(host, authenticate);
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
    this.activeStreams.set(requestId, abortController);

    const tools = Array.from(registered.toolIndex.values()).map((e) => e.def);
    const self = this;

    const executeTool = async (
      name: string,
      args: unknown,
    ): Promise<unknown> => {
      const entry = registered.toolIndex.get(name);
      if (!entry) throw new Error(`Unknown tool: ${name}`);

      let result: unknown;
      if (entry.source === "toolkit") {
        if (!self.context) {
          throw new Error(
            "Plugin tool execution requires PluginContext; this should never happen through createApp",
          );
        }
        result = await self.context.executeTool(
          req,
          entry.pluginName,
          entry.localName,
          args,
          signal,
        );
      } else if (entry.source === "function") {
        result = await entry.functionTool.execute(
          args as Record<string, unknown>,
        );
      } else if (entry.source === "mcp") {
        if (!self.mcpClient) throw new Error("MCP client not connected");
        const oboToken = req.headers["x-forwarded-access-token"];
        const mcpAuth =
          typeof oboToken === "string"
            ? { Authorization: `Bearer ${oboToken}` }
            : undefined;
        result = await self.mcpClient.callTool(
          entry.mcpToolName,
          args,
          mcpAuth,
        );
      } else if (entry.source === "subagent") {
        const childAgent = self.agents.get(entry.agentName);
        if (!childAgent)
          throw new Error(`Sub-agent not found: ${entry.agentName}`);
        result = await self.runSubAgent(req, childAgent, args, signal);
      }

      if (result === undefined) {
        return `Error: Tool "${name}" execution failed`;
      }
      const MAX = 50_000;
      const serialized =
        typeof result === "string" ? result : JSON.stringify(result);
      if (serialized.length > MAX) {
        return `${serialized.slice(0, MAX)}\n\n[Result truncated: ${serialized.length} chars exceeds ${MAX} limit]`;
      }
      return result;
    };

    await this.executeStream<ResponseStreamEvent>(
      res,
      async function* () {
        const translator = new AgentEventTranslator();
        try {
          for (const evt of translator.translate({
            type: "metadata",
            data: { threadId: thread.id },
          })) {
            yield evt;
          }

          const pluginNames = self.context
            ? self.context
                .getPluginNames()
                .filter((n) => n !== self.name && n !== "server")
            : [];
          const fullPrompt = composePromptForAgent(
            registered,
            self.config.baseSystemPrompt,
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

          let fullContent = "";
          for await (const event of stream) {
            if (signal.aborted) break;
            if (event.type === "message_delta") {
              fullContent += event.content;
            }
            for (const translated of translator.translate(event)) {
              yield translated;
            }
          }

          if (fullContent) {
            await self.threadStore.addMessage(thread.id, userId, {
              id: randomUUID(),
              role: "assistant",
              content: fullContent,
              createdAt: new Date(),
            });
          }

          for (const evt of translator.finalize()) yield evt;
        } catch (error) {
          if (signal.aborted) return;
          logger.error("Agent chat error: %O", error);
          throw error;
        } finally {
          self.activeStreams.delete(requestId);
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
   */
  private async runSubAgent(
    req: express.Request,
    child: RegisteredAgent,
    args: unknown,
    signal: AbortSignal,
  ): Promise<string> {
    const input =
      typeof args === "object" &&
      args !== null &&
      typeof (args as { input?: unknown }).input === "string"
        ? (args as { input: string }).input
        : JSON.stringify(args);
    const childTools = Array.from(child.toolIndex.values()).map((e) => e.def);

    const childExecute = async (
      name: string,
      childArgs: unknown,
    ): Promise<unknown> => {
      const entry = child.toolIndex.get(name);
      if (!entry) throw new Error(`Unknown tool in sub-agent: ${name}`);
      if (entry.source === "toolkit" && this.context) {
        return this.context.executeTool(
          req,
          entry.pluginName,
          entry.localName,
          childArgs,
          signal,
        );
      }
      if (entry.source === "function") {
        return entry.functionTool.execute(childArgs as Record<string, unknown>);
      }
      if (entry.source === "subagent") {
        const grandchild = this.agents.get(entry.agentName);
        if (!grandchild)
          throw new Error(`Sub-agent not found: ${entry.agentName}`);
        return this.runSubAgent(req, grandchild, childArgs, signal);
      }
      if (entry.source === "mcp" && this.mcpClient) {
        const oboToken = req.headers["x-forwarded-access-token"];
        const mcpAuth =
          typeof oboToken === "string"
            ? { Authorization: `Bearer ${oboToken}` }
            : undefined;
        return this.mcpClient.callTool(entry.mcpToolName, childArgs, mcpAuth);
      }
      throw new Error(`Unsupported sub-agent tool source: ${entry.source}`);
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

    let output = "";
    const events: AgentEvent[] = [];
    for await (const event of child.adapter.run(
      { messages, tools: childTools, threadId: randomUUID(), signal },
      runContext,
    )) {
      events.push(event);
      if (event.type === "message_delta") output += event.content;
      else if (event.type === "message") output = event.content;
    }
    return output;
  }

  private async _handleCancel(req: express.Request, res: express.Response) {
    const { streamId } = req.body as { streamId?: string };
    if (!streamId) {
      res.status(400).json({ error: "streamId is required" });
      return;
    }
    const controller = this.activeStreams.get(streamId);
    if (controller) {
      controller.abort("Cancelled by user");
      this.activeStreams.delete(streamId);
    }
    res.json({ cancelled: true });
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
  if (value === undefined) return { file: true, code: false };
  if (typeof value === "boolean") return { file: value, code: value };
  return { file: value.file ?? true, code: value.code ?? false };
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
    base = buildBaseSystemPrompt(ctx.pluginNames);
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
