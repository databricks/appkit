import type { DatabricksMCPServer } from "@databricks/langchainjs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BasePluginConfig } from "shared";
import type { AgentInterface } from "./agent-interface";
import type { FunctionTool } from "./function-tool";

/**
 * A tool that can be registered with the agent plugin.
 *
 * - `FunctionTool` (preferred): OpenResponses-aligned plain object with JSON Schema parameters.
 * - `StructuredToolInterface`: LangChain tool for advanced use cases.
 */
export type AgentTool = FunctionTool | StructuredToolInterface;

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

  /**
   * Tools to register with the agent. Accepts OpenResponses-aligned FunctionTool
   * objects or LangChain StructuredToolInterface instances.
   * Ignored when `agentInstance` is provided.
   */
  tools?: AgentTool[];
}
