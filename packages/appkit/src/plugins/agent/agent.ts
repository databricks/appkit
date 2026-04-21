import { randomUUID } from "node:crypto";
import type express from "express";
import pc from "picocolors";
import type {
  AgentAdapter,
  AgentToolDefinition,
  IAppRouter,
  Message,
  PluginPhase,
  ResponseStreamEvent,
} from "shared";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { agentStreamDefaults } from "./defaults";
import { AgentEventTranslator } from "./event-translator";
import manifest from "./manifest.json";
import { chatRequestSchema, invocationsRequestSchema } from "./schemas";
import { InMemoryThreadStore } from "./thread-store";
import { type FunctionTool, functionToolToDefinition } from "./tools";
import type { AgentPluginConfig, RegisteredAgent, ToolEntry } from "./types";

const logger = createLogger("agent");

export class AgentPlugin extends Plugin {
  static manifest = manifest as PluginManifest<"agent">;
  static phase: PluginPhase = "deferred";

  protected declare config: AgentPluginConfig;

  private agents = new Map<string, RegisteredAgent>();
  private defaultAgentName: string | null = null;
  private toolIndex = new Map<string, ToolEntry>();
  private threadStore;
  private activeStreams = new Map<string, AbortController>();

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

    await this.configureAdapters();
    this.mountInvocationsRoute();
  }

  private mountInvocationsRoute() {
    if (!this.context) return;

    this.context.addRoute(
      "post",
      "/invocations",
      (req: express.Request, res: express.Response) => {
        this._handleInvocations(req, res);
      },
    );

    logger.info("Registered POST /invocations route via PluginContext");
  }

  private async configureAdapters() {
    const toolDefinitions = this.getAllToolDefinitions();

    for (const { name, adapter } of this.agents.values()) {
      if (adapter.configure) {
        try {
          await adapter.configure({ toolDefinitions });
        } catch (error) {
          logger.error(
            "Adapter '%s' configure() failed — it may not function correctly: %O",
            name,
            error,
          );
        }
      }
    }
  }

  private async collectTools() {
    if (this.context) {
      for (const {
        name: pluginName,
        provider,
      } of this.context.getToolProviders()) {
        const tools = provider.getAgentTools();
        for (const tool of tools) {
          const qualifiedName = `${pluginName}.${tool.name}`;
          this.toolIndex.set(qualifiedName, {
            source: "plugin",
            pluginName,
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

      let result: unknown;

      if (entry.source === "plugin" && self.context) {
        result = await self.context.executeTool(
          req,
          entry.pluginName,
          entry.localName,
          args,
          signal,
        );
      } else {
        result = await self.execute(
          async (_execSignal) => {
            switch (entry.source) {
              case "plugin":
                throw new Error("Plugin tool execution requires PluginContext");
              case "function":
                return entry.functionTool.execute(
                  args as Record<string, unknown>,
                );
              case "mcp":
                throw new Error(
                  `MCP tool "${qualifiedName}" cannot be executed locally — use the Supervisor API adapter for hosted tools`,
                );
            }
          },
          {
            default: {
              telemetryInterceptor: { enabled: true },
              timeout: 30_000,
            },
          },
        );
      }

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
    // No-op — cleanup if needed in the future
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
