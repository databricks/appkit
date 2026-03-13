/**
 * AgentPlugin — first-class AppKit plugin for LangChain/LangGraph agents.
 *
 * Provides:
 *  - POST /api/agent  (standard AppKit namespaced route)
 *
 * Supports two modes:
 *  1. Bring-your-own agent via `config.agentInstance`
 *  2. Auto-build a LangGraph ReAct agent from config (model, tools, MCP servers)
 *
 * When using config (not agentInstance), you can add tools and MCP servers
 * after app creation via appkit.agent.addTools() and appkit.agent.addMcpServers().
 */

import type { DatabricksMCPServer } from "@databricks/langchainjs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type express from "express";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import type { AgentInterface } from "./agent-interface";
import { functionToolToStructuredTool, isFunctionTool } from "./function-tool";
import { createInvokeHandler } from "./invoke-handler";
import manifest from "./manifest.json";
import { StandardAgent } from "./standard-agent";
import type { AgentTool, IAgentConfig } from "./types";

const logger = createLogger("agent");

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant with access to various tools.";

type ChatDatabricksInstance = InstanceType<
  Awaited<typeof import("@databricks/langchainjs")>["ChatDatabricks"]
>;

export class AgentPlugin extends Plugin<IAgentConfig> {
  public name = "agent" as const;

  static manifest = manifest;

  protected declare config: IAgentConfig;

  private agentImpl: AgentInterface | null = null;
  private systemPrompt = DEFAULT_SYSTEM_PROMPT;
  private mcpClient: {
    getTools(): Promise<StructuredToolInterface[]>;
    close(): Promise<void>;
  } | null = null;

  /** Only set when building from config (not agentInstance). Used when rebuilding after addTools/addMcpServers. */
  private model: ChatDatabricksInstance | null = null;
  /** Mutable list of tools (config + added). Only used when building from config. */
  private toolsList: AgentTool[] = [];
  /** Mutable list of MCP servers (config + added). Only used when building from config. */
  private mcpServersList: DatabricksMCPServer[] = [];

  /**
   * Normalize an AgentTool to a LangChain StructuredToolInterface.
   * FunctionTool objects are converted; StructuredToolInterface pass through.
   */
  private static toStructuredTool(tool: AgentTool): StructuredToolInterface {
    return isFunctionTool(tool) ? functionToolToStructuredTool(tool) : tool;
  }

  async setup() {
    this.systemPrompt = this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    // If a pre-built agent is provided, use it directly
    if (this.config.agentInstance) {
      this.agentImpl = this.config.agentInstance;
      logger.info("AgentPlugin initialized with provided agentInstance");
      return;
    }

    // Otherwise build a LangGraph ReAct agent from config
    const modelName = this.config.model ?? process.env.DATABRICKS_MODEL;

    if (!modelName) {
      throw new Error(
        "AgentPlugin: model name is required. Set config.model or DATABRICKS_MODEL env var.",
      );
    }

    const { ChatDatabricks } = await import("@databricks/langchainjs");

    this.model = new ChatDatabricks({
      model: modelName,
      useResponsesApi: this.config.useResponsesApi ?? false,
      temperature: this.config.temperature ?? 0.1,
      maxTokens: this.config.maxTokens ?? 2000,
      maxRetries: 3,
    });

    this.toolsList = [...(this.config.tools ?? [])];
    this.mcpServersList = [...(this.config.mcpServers ?? [])];

    await this.buildStandardAgent();

    logger.info(
      "AgentPlugin initialized: model=%s tools=%d mcpServers=%d",
      modelName,
      this.toolsList.length,
      this.mcpServersList.length,
    );
  }

  /**
   * Builds or rebuilds the LangGraph ReAct agent from current model, toolsList, and mcpServersList.
   * Call this after changing toolsList or mcpServersList (e.g. via addTools/addMcpServers).
   */
  private async buildStandardAgent(): Promise<void> {
    if (!this.model) return;

    // Close existing MCP client before creating a new one
    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
      } catch (err) {
        logger.warn("Error closing MCP client during rebuild: %O", err);
      }
      this.mcpClient = null;
    }

    const tools: StructuredToolInterface[] = [];

    if (this.mcpServersList.length > 0) {
      try {
        const { buildMCPServerConfig } = await import(
          "@databricks/langchainjs"
        );
        const mcpServerConfigs = await buildMCPServerConfig(
          this.mcpServersList,
        );
        const { MultiServerMCPClient } = await import(
          "@langchain/mcp-adapters"
        );
        this.mcpClient = new MultiServerMCPClient({
          mcpServers: mcpServerConfigs,
          throwOnLoadError: false,
          prefixToolNameWithServerName: true,
        });
        const mcpTools = await this.mcpClient.getTools();
        tools.push(...mcpTools);
        logger.info(
          "Loaded %d MCP tools from %d server(s)",
          mcpTools.length,
          this.mcpServersList.length,
        );
      } catch (err) {
        logger.warn(
          "Failed to load MCP tools — continuing without them: %O",
          err,
        );
      }
    }

    tools.push(...this.toolsList.map(AgentPlugin.toStructuredTool));

    const { createReactAgent } = await import("@langchain/langgraph/prebuilt");
    const langGraphAgent = createReactAgent({
      llm: this.model,
      tools,
    });

    this.agentImpl = new StandardAgent(
      langGraphAgent as any,
      this.systemPrompt,
    );
  }

  /**
   * Batch-add tools and/or MCP servers with a single agent rebuild.
   * Only supported when the plugin was initialized from config (not agentInstance).
   *
   * Tools can be OpenResponses-aligned FunctionTool objects or LangChain StructuredToolInterface.
   */
  async addCapabilities(options: {
    tools?: AgentTool[];
    mcpServers?: DatabricksMCPServer[];
  }): Promise<void> {
    if (this.config.agentInstance) {
      throw new Error(
        "addCapabilities() is not supported when using a custom agentInstance",
      );
    }
    if (!this.model) {
      throw new Error("AgentPlugin not initialized — call setup() first");
    }

    const { tools, mcpServers } = options;
    if (tools?.length) this.toolsList.push(...tools);
    if (mcpServers?.length) this.mcpServersList.push(...mcpServers);

    await this.buildStandardAgent();

    logger.info(
      "Configured agent: added %d tool(s), %d MCP server(s); totals tools=%d servers=%d",
      tools?.length ?? 0,
      mcpServers?.length ?? 0,
      this.toolsList.length,
      this.mcpServersList.length,
    );
  }

  /**
   * Add tools to the agent after app creation. Only supported when the plugin
   * was initialized from config (not when using agentInstance). Rebuilds the
   * underlying LangGraph agent with the new tool set.
   *
   * Accepts OpenResponses-aligned FunctionTool objects or LangChain StructuredToolInterface.
   */
  async addTools(tools: AgentTool[]): Promise<void> {
    await this.addCapabilities({ tools });
  }

  /**
   * Add MCP servers to the agent after app creation. Only supported when the
   * plugin was initialized from config (not when using agentInstance). Rebuilds
   * the underlying LangGraph agent so new MCP tools are available.
   */
  async addMcpServers(servers: DatabricksMCPServer[]): Promise<void> {
    await this.addCapabilities({ mcpServers: servers });
  }

  private getAgentImpl(): AgentInterface {
    if (!this.agentImpl) {
      throw new Error("AgentPlugin not initialized — call setup() first");
    }
    return this.agentImpl;
  }

  injectRoutes(router: express.Router) {
    const handler = createInvokeHandler(() => this.getAgentImpl());
    router.post("/", handler);
    this.registerEndpoint("invoke", `/api/${this.name}`);
  }

  async abortActiveOperations() {
    await super.abortActiveOperations();
    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
      } catch (err) {
        logger.warn("Error closing MCP client: %O", err);
      }
    }
  }

  exports() {
    return {
      invoke: async (
        messages: { role: string; content: string }[],
      ): Promise<string> => {
        if (!this.agentImpl) {
          throw new Error("AgentPlugin not initialized");
        }
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const input = lastUser?.content ?? "";
        const chatHistory = messages.slice(0, -1);
        const items = await this.agentImpl.invoke({
          input,
          chat_history: chatHistory,
        });
        const msg = items.find((i) => i.type === "message") as any;
        const text = msg?.content?.[0]?.text ?? "";
        return text;
      },

      stream: async function* (
        this: AgentPlugin,
        messages: { role: string; content: string }[],
      ) {
        if (!this.agentImpl) {
          throw new Error("AgentPlugin not initialized");
        }
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const input = lastUser?.content ?? "";
        const chatHistory = messages.slice(0, -1);
        yield* this.agentImpl.stream({
          input,
          chat_history: chatHistory,
        });
      }.bind(this),

      addTools: (tools: AgentTool[]) => this.addTools(tools),
      addMcpServers: (servers: DatabricksMCPServer[]) =>
        this.addMcpServers(servers),
      addCapabilities: (options: {
        tools?: AgentTool[];
        mcpServers?: DatabricksMCPServer[];
      }) => this.addCapabilities(options),
    };
  }
}

export const agent = toPlugin(AgentPlugin);
