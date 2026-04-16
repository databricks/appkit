import { randomUUID } from "node:crypto";
import path from "node:path";
import type express from "express";
import pc from "picocolors";
import type {
  AgentAdapter,
  AgentToolDefinition,
  IAppRouter,
  Message,
  PluginPhase,
  ResponseStreamEvent,
  ToolProvider,
} from "shared";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { loadAgentConfigs } from "./config-loader";
import { agentStreamDefaults } from "./defaults";
import { AgentEventTranslator } from "./event-translator";
import manifest from "./manifest.json";
import { chatRequestSchema, invocationsRequestSchema } from "./schemas";
import { buildBaseSystemPrompt, composeSystemPrompt } from "./system-prompt";
import { InMemoryThreadStore } from "./thread-store";
import {
  AppKitMcpClient,
  type FunctionTool,
  functionToolToDefinition,
  isFunctionTool,
  isHostedTool,
  resolveHostedTools,
} from "./tools";
import type { AgentPluginConfig, RegisteredAgent, ToolEntry } from "./types";

const logger = createLogger("agent");

function isToolProvider(obj: unknown): obj is ToolProvider {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "getAgentTools" in obj &&
    typeof (obj as any).getAgentTools === "function" &&
    "executeAgentTool" in obj &&
    typeof (obj as any).executeAgentTool === "function"
  );
}

export class AgentPlugin extends Plugin {
  static manifest = manifest as PluginManifest<"agent">;
  static phase: PluginPhase = "deferred";

  protected declare config: AgentPluginConfig;

  private agents = new Map<string, RegisteredAgent>();
  private defaultAgentName: string | null = null;
  private toolIndex = new Map<string, ToolEntry>();
  private threadStore;
  private activeStreams = new Map<string, AbortController>();
  private mcpClient: AppKitMcpClient | null = null;

  constructor(config: AgentPluginConfig) {
    super(config);
    this.config = config;
    this.threadStore = config.threadStore ?? new InMemoryThreadStore();
  }

  async setup() {
    await this.collectTools();
    await this.loadAgents();
    this.mountInvocationsRoute();
  }

  private async loadAgents() {
    // 1. Load config-file agents first
    const agentsDir =
      this.config.agentsDir ?? path.join(process.cwd(), "config/agents");
    const fileConfigs = loadAgentConfigs(agentsDir);

    for (const fc of fileConfigs) {
      try {
        const { DatabricksAdapter } = await import("../../agents/databricks");
        const adapter = await DatabricksAdapter.fromModelServing(fc.endpoint, {
          maxSteps: fc.maxSteps,
          maxTokens: fc.maxTokens,
        });
        this.agents.set(fc.name, {
          name: fc.name,
          adapter,
          systemPrompt: fc.systemPrompt || undefined,
        });
        if (fc.default && !this.defaultAgentName) {
          this.defaultAgentName = fc.name;
        }
        if (!this.defaultAgentName) {
          this.defaultAgentName = fc.name;
        }
      } catch (error) {
        logger.error(
          "Failed to create agent '%s' from config: %O",
          fc.name,
          error,
        );
      }
    }

    // 2. Code-defined agents override config-file agents per-name
    if (this.config.agents) {
      const entries = Object.entries(this.config.agents);
      for (const [name, entry] of entries) {
        if (
          this.agents.has(name) &&
          fileConfigs.some((fc) => fc.name === name)
        ) {
          logger.warn(
            "Agent '%s' defined in both code and config file. Code takes precedence.",
            name,
          );
        }

        const { adapter, systemPrompt } = await this.resolveAgentEntry(entry);
        this.agents.set(name, { name, adapter, systemPrompt });
        if (!this.defaultAgentName) {
          this.defaultAgentName = name;
        }
      }
    }

    if (this.config.defaultAgent) {
      this.defaultAgentName = this.config.defaultAgent;
    }

    if (fileConfigs.length > 0) {
      logger.info(
        "Loaded %d agent(s) from config files: %s",
        fileConfigs.length,
        fileConfigs.map((c) => c.name).join(", "),
      );
    }
  }

  private async resolveAgentEntry(
    entry: import("./types").AgentEntry,
  ): Promise<{ adapter: AgentAdapter; systemPrompt?: string }> {
    if (this.isAgentDefinition(entry)) {
      const adapter = await entry.adapter;
      return { adapter, systemPrompt: entry.systemPrompt };
    }
    const adapter = await (entry as AgentAdapter | Promise<AgentAdapter>);
    return { adapter };
  }

  private isAgentDefinition(
    entry: unknown,
  ): entry is import("./types").AgentDefinition {
    return typeof entry === "object" && entry !== null && "adapter" in entry;
  }

  async reloadAgents() {
    this.agents.clear();
    this.defaultAgentName = null;
    await this.loadAgents();
  }

  private mountInvocationsRoute() {
    const serverPlugin = this.config.plugins?.server as
      | { addExtension?: (fn: (app: any) => void) => void }
      | undefined;

    if (!serverPlugin?.addExtension) return;

    serverPlugin.addExtension((app: import("express").Application) => {
      app.post(
        "/invocations",
        (req: express.Request, res: express.Response) => {
          this._handleInvocations(req, res);
        },
      );
    });

    logger.info("Mounted POST /invocations route");
  }

  private async collectTools() {
    // 1. Auto-discover from sibling ToolProvider plugins
    const plugins = this.config.plugins;
    if (plugins) {
      for (const [pluginName, pluginInstance] of Object.entries(plugins)) {
        if (pluginName === "agent") continue;
        if (!isToolProvider(pluginInstance)) continue;

        const tools = (pluginInstance as ToolProvider).getAgentTools();
        for (const tool of tools) {
          const qualifiedName = `${pluginName}.${tool.name}`;
          this.toolIndex.set(qualifiedName, {
            source: "plugin",
            plugin: pluginInstance as ToolProvider & {
              asUser(req: any): any;
            },
            def: { ...tool, name: qualifiedName },
            localName: tool.name,
          });
        }

        logger.info(
          "Collected %d tools from plugin %s",
          tools.length,
          pluginName,
        );
      }
    }

    // 2. Process explicit tools from config
    if (this.config.tools) {
      const hostedTools = this.config.tools.filter(isHostedTool);
      const functionTools = this.config.tools.filter(isFunctionTool);

      // 2a. Resolve HostedTools via MCP client
      if (hostedTools.length > 0) {
        await this.connectHostedTools(hostedTools);
      }

      // 2b. Add FunctionTools
      for (const ft of functionTools) {
        this.addFunctionToolToIndex(ft);
      }
    }

    this.printTools();
  }

  private printTools() {
    const entries = Array.from(this.toolIndex.values());
    if (entries.length === 0) return;

    const SOURCE_COLORS: Record<string, (s: string) => string> = {
      plugin: pc.blue,
      function: pc.yellow,
      mcp: pc.magenta,
    };

    const rows = entries
      .map((e) => ({
        source: e.source,
        name: e.def.name,
        description: e.def.description.slice(0, 60),
      }))
      .sort(
        (a, b) =>
          a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
      );

    const maxSourceLen = Math.max(...rows.map((r) => r.source.length));
    const maxNameLen = Math.min(
      40,
      Math.max(...rows.map((r) => r.name.length)),
    );
    const separator = pc.dim("─".repeat(60));

    console.log("");
    console.log(`  ${pc.bold("Agent Tools")} ${pc.dim(`(${rows.length})`)}`);
    console.log(`  ${separator}`);

    for (const { source, name, description } of rows) {
      const colorize = SOURCE_COLORS[source] ?? pc.white;
      const sourceStr = colorize(pc.bold(source.padEnd(maxSourceLen)));
      const nameStr =
        name.length > maxNameLen
          ? `${name.slice(0, maxNameLen - 1)}…`
          : name.padEnd(maxNameLen);
      console.log(`  ${sourceStr}  ${nameStr}  ${pc.dim(description)}`);
    }

    console.log(`  ${separator}`);
    console.log("");
  }

  private async connectHostedTools(
    hostedTools: import("./tools/hosted-tools").HostedTool[],
  ) {
    let host: string | undefined;
    let authenticate: () => Promise<Record<string, string>>;

    try {
      const { getWorkspaceClient } = await import("../../context");
      const wsClient = getWorkspaceClient();
      await wsClient.config.ensureResolved();
      host = wsClient.config.host;
      authenticate = async (): Promise<Record<string, string>> => {
        const headers = new Headers();
        await wsClient.config.authenticate(headers);
        return Object.fromEntries(headers.entries());
      };
    } catch {
      host = process.env.DATABRICKS_HOST;
      authenticate = async (): Promise<Record<string, string>> => {
        const token = process.env.DATABRICKS_TOKEN;
        if (token) return { Authorization: `Bearer ${token}` };
        return {};
      };
    }

    if (!host) {
      logger.warn(
        "No Databricks host available — skipping %d hosted tools",
        hostedTools.length,
      );
      return;
    }

    this.mcpClient = new AppKitMcpClient(host, authenticate);

    const endpoints = resolveHostedTools(hostedTools);
    await this.mcpClient.connectAll(endpoints);

    for (const def of this.mcpClient.getAllToolDefinitions()) {
      this.toolIndex.set(def.name, {
        source: "mcp",
        mcpToolName: def.name,
        def,
      });
    }

    logger.info(
      "Connected %d MCP tools from %d hosted tool(s)",
      this.mcpClient.getAllToolDefinitions().length,
      hostedTools.length,
    );
  }

  private addFunctionToolToIndex(ft: FunctionTool) {
    const def = functionToolToDefinition(ft);
    this.toolIndex.set(ft.name, {
      source: "function",
      functionTool: ft,
      def,
    });
  }

  addTools(tools: FunctionTool[]) {
    for (const ft of tools) {
      this.addFunctionToolToIndex(ft);
    }
    logger.info(
      "Added %d function tools, total: %d",
      tools.length,
      this.toolIndex.size,
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
          toolCount: this.toolIndex.size,
          tools: this.getAllToolDefinitions(),
          agents: Array.from(this.agents.keys()),
          defaultAgent: this.defaultAgentName,
        });
      },
    });
  }

  clientConfig(): Record<string, unknown> {
    return {
      tools: this.getAllToolDefinitions(),
      agents: Array.from(this.agents.keys()),
      defaultAgent: this.defaultAgentName,
    };
  }

  private async _handleChat(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { message, threadId, agent: agentName } = parsed.data;

    const resolvedAgent = this.resolveAgent(agentName);
    if (!resolvedAgent) {
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

    return this._streamChat(req, res, resolvedAgent, thread, userId);
  }

  private async _streamChat(
    req: express.Request,
    res: express.Response,
    resolvedAgent: RegisteredAgent,
    thread: import("shared").Thread,
    userId: string,
  ): Promise<void> {
    const tools = this.getAllToolDefinitions();
    const abortController = new AbortController();
    const signal = abortController.signal;

    const self = this;
    const executeTool = async (
      qualifiedName: string,
      args: unknown,
    ): Promise<unknown> => {
      const entry = self.toolIndex.get(qualifiedName);
      if (!entry) throw new Error(`Unknown tool: ${qualifiedName}`);

      const result = await self.execute(
        async (execSignal) => {
          switch (entry.source) {
            case "plugin": {
              const target = (entry.plugin as any).asUser(req);
              return (target as ToolProvider).executeAgentTool(
                entry.localName,
                args,
                execSignal,
              );
            }
            case "function":
              return entry.functionTool.execute(
                args as Record<string, unknown>,
              );
            case "mcp": {
              if (!self.mcpClient) {
                throw new Error("MCP client not connected");
              }
              const oboToken = req.headers["x-forwarded-access-token"];
              const mcpAuth =
                typeof oboToken === "string"
                  ? { Authorization: `Bearer ${oboToken}` }
                  : undefined;
              return self.mcpClient.callTool(entry.mcpToolName, args, mcpAuth);
            }
          }
        },
        {
          default: {
            telemetryInterceptor: { enabled: true },
            timeout: 30_000,
          },
        },
      );

      if (result === undefined) {
        return `Error: Tool "${qualifiedName}" execution failed`;
      }

      const MAX_TOOL_RESULT_CHARS = 50_000;
      const serialized =
        typeof result === "string" ? result : JSON.stringify(result);
      if (serialized.length > MAX_TOOL_RESULT_CHARS) {
        return `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[Result truncated: ${serialized.length} chars exceeds ${MAX_TOOL_RESULT_CHARS} limit]`;
      }
      return result;
    };

    const requestId = randomUUID();
    this.activeStreams.set(requestId, abortController);

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

          const pluginNames = self.config.plugins
            ? Object.keys(self.config.plugins).filter(
                (n) => n !== "agent" && n !== "server",
              )
            : [];
          const basePrompt = buildBaseSystemPrompt(pluginNames);
          const fullPrompt = composeSystemPrompt(
            basePrompt,
            resolvedAgent.systemPrompt,
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

          const stream = resolvedAgent.adapter.run(
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
            const assistantMessage: Message = {
              id: randomUUID(),
              role: "assistant",
              content: fullContent,
              createdAt: new Date(),
            };
            await self.threadStore.addMessage(
              thread.id,
              userId,
              assistantMessage,
            );
          }

          for (const evt of translator.finalize()) {
            yield evt;
          }
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
        stream: {
          ...agentStreamDefaults.stream,
          streamId: requestId,
        },
      },
    );
  }

  private async _handleInvocations(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const parsed = invocationsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { input } = parsed.data;
    const resolvedAgent = this.resolveAgent();
    if (!resolvedAgent) {
      res.status(400).json({ error: "No agent registered" });
      return;
    }

    const userId = this.resolveUserId(req);
    const thread = await this.threadStore.create(userId);

    if (typeof input === "string") {
      const msg: Message = {
        id: randomUUID(),
        role: "user",
        content: input,
        createdAt: new Date(),
      };
      await this.threadStore.addMessage(thread.id, userId, msg);
    } else {
      for (const item of input) {
        const role = item.role ?? "user";
        const content =
          typeof item.content === "string"
            ? item.content
            : JSON.stringify(item.content ?? "");
        if (!content) continue;
        const msg: Message = {
          id: randomUUID(),
          role: role as Message["role"],
          content,
          createdAt: new Date(),
        };
        await this.threadStore.addMessage(thread.id, userId, msg);
      }
    }

    return this._streamChat(req, res, resolvedAgent, thread, userId);
  }

  private async _handleCancel(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
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
  ): Promise<void> {
    const userId = this.resolveUserId(req);
    const threads = await this.threadStore.list(userId);
    res.json({ threads });
  }

  private async _handleGetThread(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
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
  ): Promise<void> {
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

  private getAllToolDefinitions(): AgentToolDefinition[] {
    return Array.from(this.toolIndex.values()).map((e) => e.def);
  }

  async shutdown() {
    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
    }
  }

  exports() {
    return {
      registerAgent: (name: string, adapter: AgentAdapter) => {
        this.agents.set(name, { name, adapter });
        if (!this.defaultAgentName) {
          this.defaultAgentName = name;
        }
      },
      addTools: (tools: FunctionTool[]) => this.addTools(tools),
      getTools: () => this.getAllToolDefinitions(),
      getThreads: (userId: string) => this.threadStore.list(userId),
      getAgents: () => ({
        agents: Array.from(this.agents.keys()),
        default: this.defaultAgentName,
      }),
      reloadAgents: () => this.reloadAgents(),
    };
  }
}

/**
 * @internal
 */
export const agent = toPlugin(AgentPlugin);
