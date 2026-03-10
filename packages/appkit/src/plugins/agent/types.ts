import type { DatabricksMCPServer } from "@databricks/langchainjs";
import type { StructuredTool } from "@langchain/core/tools";
import type { BasePluginConfig } from "shared";
import type { AgentInterface } from "./agent-interface";

export interface IAgentConfig extends BasePluginConfig {
  /**
   * Pre-built agent implementing AgentInterface.
   * When provided the plugin skips internal LangGraph setup and delegates
   * directly to this instance. Use this to bring your own agent
   * implementation or a different LangChain variant.
   */
  agentInstance?: AgentInterface;

  /**
   * Databricks model serving endpoint name (e.g. "databricks-claude-sonnet-4-5").
   * Falls back to DATABRICKS_MODEL env var.
   * Ignored when `agentInstance` is provided.
   */
  model?: string;

  /**
   * Whether ChatDatabricks calls the upstream model using the Responses API
   * instead of the Chat Completions API. Default: false.
   * Ignored when `agentInstance` is provided.
   */
  useResponsesApi?: boolean;

  /** System prompt injected at the start of every conversation */
  systemPrompt?: string;

  /** Sampling temperature (0.0-1.0, default 0.1). Ignored when `agentInstance` is provided. */
  temperature?: number;

  /** Max tokens to generate (default 2000). Ignored when `agentInstance` is provided. */
  maxTokens?: number;

  /** MCP servers for Databricks tool integration. Ignored when `agentInstance` is provided. */
  mcpServers?: DatabricksMCPServer[];

  /** Additional LangChain tools to register alongside MCP tools. Ignored when `agentInstance` is provided. */
  tools?: StructuredTool[];
}
