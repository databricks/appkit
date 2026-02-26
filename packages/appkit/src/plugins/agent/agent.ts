/**
 * AgentPlugin — first-class AppKit plugin for LangChain/LangGraph agents.
 *
 * Ported from ~/app-templates/agent-langchain-ts/src/framework/plugins/agent/AgentPlugin.ts
 * and ~/app-templates/agent-langchain-ts/src/agent.ts
 */

import type { DatabricksMCPServer } from "@databricks/langchainjs";
import { buildMCPServerConfig, ChatDatabricks } from "@databricks/langchainjs";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type express from "express";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import { createInvokeHandler, type InvokableAgent } from "./invoke-handler";
import { agentManifest } from "./manifest";
import type { AgentTraceDestination, IAgentConfig } from "./types";

const logger = createLogger("agent");

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant with access to various tools.";

export class AgentPlugin extends Plugin<IAgentConfig> {
  public name = "agent" as const;

  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = agentManifest;

  protected declare config: IAgentConfig;

  private langGraphAgent: InvokableAgent | null = null;
  private systemPrompt = DEFAULT_SYSTEM_PROMPT;
  private mcpClient: { close(): Promise<void> } | null = null;

  /**
   * Provides config-dependent resource requirements:
   * when traceDestination.type === 'mlflow' and no experimentId in config,
   * MLFLOW_EXPERIMENT_ID env var becomes required.
   */
  static getResourceRequirements(config: IAgentConfig) {
    const resources = [];
    if (
      config.traceDestination?.type === "mlflow" &&
      !config.traceDestination.experimentId
    ) {
      resources.push({
        type: "experiment" as const,
        alias: "MLflow Experiment",
        resourceKey: "agent-mlflow-experiment",
        description:
          "MLflow experiment for tracing agent invocations (required when traceDestination.type is 'mlflow' and no experimentId is provided in config)",
        permission: "CAN_READ" as const,
        fields: {
          id: { env: "MLFLOW_EXPERIMENT_ID" },
        },
        required: true,
      });
    }
    return resources;
  }

  async setup() {
    this.systemPrompt = this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    // Initialize tracing if requested
    if (this.config.traceDestination?.type === "mlflow") {
      await this._setupMLflowTracing(this.config.traceDestination);
    }

    // Resolve model name from config or environment
    const modelName =
      this.config.model ?? process.env.DATABRICKS_AGENT_SERVING_ENDPOINT_NAME;

    if (!modelName) {
      throw new Error(
        "AgentPlugin: model name is required. Set config.model or DATABRICKS_AGENT_SERVING_ENDPOINT_NAME env var.",
      );
    }

    // Create ChatDatabricks model
    const model = new ChatDatabricks({
      model: modelName,
      temperature: this.config.temperature ?? 0.1,
      maxTokens: this.config.maxTokens ?? 2000,
      maxRetries: 3,
    });

    // Load MCP tools if configured
    const tools: any[] = [];

    if (this.config.mcpServers?.length) {
      try {
        // Build MCP server configurations (handles Databricks auth)
        const mcpServerConfigs = await buildMCPServerConfig(
          this.config.mcpServers,
        );

        // Dynamically import MultiServerMCPClient to avoid hard dep at module level
        const { MultiServerMCPClient } = await import(
          "@langchain/mcp-adapters"
        );
        this.mcpClient = new MultiServerMCPClient({
          mcpServers: mcpServerConfigs,
          throwOnLoadError: false,
          prefixToolNameWithServerName: true,
        });

        const mcpTools = await (this.mcpClient as any).getTools();
        tools.push(...mcpTools);
        logger.info(
          "Loaded %d MCP tools from %d server(s)",
          tools.length,
          this.config.mcpServers.length,
        );
      } catch (err) {
        logger.warn(
          "Failed to load MCP tools: %O — continuing without them",
          err,
        );
      }
    }

    // Add any statically configured tools
    if (this.config.tools?.length) {
      tools.push(...this.config.tools);
    }

    // Create the LangGraph ReAct agent
    this.langGraphAgent = createReactAgent({
      llm: model,
      tools,
    }) as InvokableAgent;

    logger.info(
      "AgentPlugin initialized: model=%s tools=%d systemPrompt=%s",
      modelName,
      tools.length,
      this.systemPrompt.slice(0, 60),
    );
  }

  injectRoutes(router: express.Router) {
    // POST /api/agent — standard appkit invoke endpoint (streaming Responses API format)
    router.post(
      "/",
      createInvokeHandler(
        () => this.langGraphAgent!,
        () => this.systemPrompt,
      ),
    );
    this.registerEndpoint("invoke", `/api/${this.name}`);
  }

  /**
   * Inject /invocations at root level — the Databricks model serving convention.
   * Called by ServerPlugin after plugin routes are mounted.
   */
  injectAppRoutes(app: express.Application) {
    app.post(
      "/invocations",
      createInvokeHandler(
        () => this.langGraphAgent!,
        () => this.systemPrompt,
      ),
    );
  }

  async shutdown() {
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
      /**
       * Invoke the agent and return the full text response.
       */
      invoke: async (
        messages: { role: string; content: string }[],
      ): Promise<string> => {
        if (!this.langGraphAgent)
          throw new Error("AgentPlugin not initialized");
        const builtMessages = [
          new SystemMessage(this.systemPrompt),
          ...messages.map((m) =>
            m.role === "user"
              ? new HumanMessage(m.content)
              : new SystemMessage(m.content),
          ),
        ];
        const result = await this.langGraphAgent.invoke({
          messages: builtMessages,
        });
        const finalMessages = result.messages ?? [];
        const last = finalMessages[finalMessages.length - 1];
        return typeof last?.content === "string" ? last.content : "";
      },

      /**
       * Stream agent response as text chunks.
       */
      stream: async function* (
        this: AgentPlugin,
        messages: { role: string; content: string }[],
      ) {
        if (!this.langGraphAgent)
          throw new Error("AgentPlugin not initialized");
        const builtMessages = [
          new SystemMessage(this.systemPrompt),
          ...messages.map((m) =>
            m.role === "user"
              ? new HumanMessage(m.content)
              : new SystemMessage(m.content),
          ),
        ];
        const stream = this.langGraphAgent.streamEvents(
          { messages: builtMessages },
          { version: "v2" },
        );
        for await (const event of stream) {
          if (event.event === "on_chat_model_stream") {
            const content = event.data?.chunk?.content;
            if (content && typeof content === "string") {
              yield content;
            }
          }
        }
      }.bind(this),
    };
  }

  /**
   * Set up MLflow/OTel tracing.
   * Uses the OTLP exporter already available in appkit pointed at the
   * Databricks OTel collector endpoint, enriched with MLflow headers.
   */
  private async _setupMLflowTracing(
    dest: Extract<AgentTraceDestination, { type: "mlflow" }>,
  ) {
    const experimentId = dest.experimentId ?? process.env.MLFLOW_EXPERIMENT_ID;

    if (!experimentId) {
      logger.warn(
        "AgentPlugin: traceDestination.type is 'mlflow' but no experimentId found. " +
          "Set traceDestination.experimentId or MLFLOW_EXPERIMENT_ID to enable tracing.",
      );
      return;
    }

    const databricksHost = process.env.DATABRICKS_HOST;
    if (!databricksHost) {
      logger.warn(
        "AgentPlugin: DATABRICKS_HOST not set, skipping MLflow tracing setup.",
      );
      return;
    }

    // Set up environment variables consumed by the existing TelemetryManager
    // so that OTel spans are exported to the Databricks MLflow endpoint.
    const host = databricksHost.replace(/\/$/, "");
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${host}/api/2.0/otel/v1/traces`;
    }

    // Pass experiment ID as an OTel resource attribute recognised by MLflow
    const existing = process.env.OTEL_RESOURCE_ATTRIBUTES ?? "";
    const expAttr = `mlflow.experimentId=${experimentId}`;
    if (!existing.includes(expAttr)) {
      process.env.OTEL_RESOURCE_ATTRIBUTES = existing
        ? `${existing},${expAttr}`
        : expAttr;
    }

    logger.info(
      "MLflow tracing configured: experimentId=%s endpoint=%s",
      experimentId,
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    );
  }
}

export const agent = toPlugin<typeof AgentPlugin, IAgentConfig, "agent">(
  AgentPlugin,
  "agent",
);
