import type { DatabricksMCPServer } from "@databricks/langchainjs";
import type { StructuredTool } from "@langchain/core/tools";
import type { BasePluginConfig } from "shared";

export interface IAgentConfig extends BasePluginConfig {
  /**
   * Databricks model serving endpoint name (e.g. "databricks-claude-sonnet-4-5").
   * Falls back to DATABRICKS_AGENT_SERVING_ENDPOINT_NAME env var.
   */
  model?: string;

  /** System prompt injected at the start of every conversation */
  systemPrompt?: string;

  /** Sampling temperature (0.0–1.0, default 0.1) */
  temperature?: number;

  /** Max tokens to generate (default 2000) */
  maxTokens?: number;

  /** MCP servers for Databricks tool integration (SQL, Vector Search, Genie, UC Functions) */
  mcpServers?: DatabricksMCPServer[];

  /** Additional LangChain tools to register alongside MCP tools */
  tools?: StructuredTool[];

  /**
   * Where to send agent traces. Defaults to no tracing if omitted.
   *
   * @example MLflow experiment
   * traceDestination: { type: 'mlflow', experimentId: '123456789' }
   *
   * (experimentId also resolved from MLFLOW_EXPERIMENT_ID env var when type is 'mlflow')
   */
  traceDestination?: AgentTraceDestination;
}

/**
 * Discriminated union — extensible to other backends (OTEL collector, custom exporters, etc.)
 */
export type AgentTraceDestination =
  | { type: "mlflow"; experimentId?: string }
  | { type: "none" };
