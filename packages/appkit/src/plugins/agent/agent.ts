import { randomUUID } from "node:crypto";
import type express from "express";
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
import { agentStreamDefaults } from "./defaults";
import { AgentEventTranslator } from "./event-translator";
import manifest from "./manifest.json";
import { chatRequestSchema, invocationsRequestSchema } from "./schemas";
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

    if (this.config.agents) {
      const entries = Object.entries(this.config.agents);
      const resolved = await Promise.all(
        entries.map(async ([name, adapterOrPromise]) => ({
          name,
          adapter: await adapterOrPromise,
        })),
      );
      for (const { name, adapter } of resolved) {
        this.agents.set(name, { name, adapter });
        if (!this.defaultAgentName) {
          this.defaultAgentName = name;
        }
      }
    }

    if (this.config.defaultAgent) {
      this.defaultAgentName = this.config.defaultAgent;
    }

    this.mountInvocationsRoute();
  }

  private mountInvocationsRoute() {
    const serverPlugin = this.config.plugins?.server as
      | { serverExtensions?: Array<(app: any) => void> }
      | undefined;

    if (!serverPlugin) return;

    const extensions = (serverPlugin as any).serverExtensions as
      | Array<(app: any) => void>
      | undefined;

    if (!extensions) return;

    extensions.push((app: import("express").Application) => {
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

    logger.info("Total agent tools: %d", this.toolIndex.size);
  }

  private async connectHostedTools(
    hostedTools: import("./tools/hosted-tools").HostedTool[],
  ) {
    const host = process.env.DATABRICKS_HOST;
    if (!host) {
      logger.warn(
        "DATABRICKS_HOST not set — skipping %d hosted tools",
        hostedTools.length,
      );
      return;
    }

    this.mcpClient = new AppKitMcpClient(
      host,
      async (): Promise<Record<string, string>> => {
        const token = process.env.DATABRICKS_TOKEN;
        if (token) return { Authorization: `Bearer ${token}` };
        return {};
      },
    );

    const endpoints = resolveHostedTools(hostedTools);
    await this.mcpClient.connectAll(endpoints);

    for (const def of this.mcpClient.getAllToolDefinitions()) {
      this.toolIndex.set(def.name, {
        source: "mcp",
        mcpToolName: def.name,
        def,
      });
    }
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
      name: "tools",
      method: "get",
      path: "/tools",
      handler: async (req, res) => this._handleListTools(req, res),
    });

    this.route(router, {
      name: "agents",
      method: "get",
      path: "/agents",
      handler: async (_req, res) => {
        res.json({
          agents: Array.from(this.agents.keys()),
          default: this.defaultAgentName,
        });
      },
    });
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

      return self.execute(
        async (execSignal) => {
          switch (entry.source) {
            case "plugin": {
              const target = entry.def.annotations?.requiresUserContext
                ? (entry.plugin as any).asUser(req)
                : entry.plugin;
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
              return self.mcpClient.callTool(entry.mcpToolName, args);
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

          const stream = resolvedAgent.adapter.run(
            {
              messages: [...thread.messages],
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

    let userMessage: string;
    if (typeof input === "string") {
      userMessage = input;
    } else {
      const last = [...input].reverse().find((m) => m.role === "user");
      const content = last?.content;
      if (!content || typeof content !== "string") {
        res.status(400).json({ error: "No user message found in input" });
        return;
      }
      userMessage = content;
    }

    req.body = { message: userMessage };
    return this._handleChat(req, res);
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

  private async _handleListTools(
    _req: express.Request,
    res: express.Response,
  ): Promise<void> {
    res.json({ tools: this.getAllToolDefinitions() });
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
    };
  }
}

/**
 * @internal
 */
export const agent = toPlugin(AgentPlugin);
