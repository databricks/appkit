import type { BasePluginConfig } from "shared";
import type { AgentInterface } from "./agent-interface";
import type { FunctionTool } from "./function-tool";
import type { HostedTool } from "./hosted-tools";

/**
 * A tool that can be registered with the agent plugin.
 *
 * - `FunctionTool`: OpenResponses-aligned plain object with JSON Schema parameters and an execute handler.
 * - `HostedTool`: Databricks-hosted tool (genie, vector_search_index, custom_mcp_server, external_mcp_server).
 */
export type AgentTool = FunctionTool | HostedTool;

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

  /**
   * Tools to register with the agent. Accepts:
   * - OpenResponses-aligned `FunctionTool` objects (local tool with execute handler)
   * - Databricks hosted tools (`genie`, `vector_search_index`, `custom_mcp_server`, `external_mcp_server`)
   *
   * Ignored when `agentInstance` is provided.
   */
  tools?: AgentTool[];

  /**
   * LangChain tracing configuration. Default: enabled.
   *
   * When enabled, instruments @langchain/core callbacks so that agent
   * spans are emitted through AppKit's global tracer provider (TelemetryManager).
   *
   * The `experimentId` and `ucTableName` fields (or their corresponding
   * env vars MLFLOW_EXPERIMENT_ID / OTEL_UC_TABLE_NAME) are forwarded as
   * headers on the OTLP trace exporter via `appendTraceHeaders`.
   *
   * Pass `false` to disable LangChain tracing instrumentation entirely.
   */
  tracing?:
  | false
  | {
    /** MLflow experiment ID. Defaults to MLFLOW_EXPERIMENT_ID env. */
    experimentId?: string;
    /**
     * UC table name (catalog.schema.table). Defaults to OTEL_UC_TABLE_NAME env.
     * Catalog and schema are derived from this value for trace location setup.
     */
    ucTableName?: string;
    /** SQL warehouse ID for creating UC trace storage. Defaults to MLFLOW_TRACING_SQL_WAREHOUSE_ID env. */
    warehouseId?: string;
  };
}
