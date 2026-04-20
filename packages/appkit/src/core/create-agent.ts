import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type {
  AgentAdapter,
  AgentToolDefinition,
  CacheConfig,
  PluginConstructor,
  PluginData,
} from "shared";
import { agent } from "../plugins/agent";
import type { AgentTool } from "../plugins/agent/types";
import type { FunctionTool } from "../plugins/agents/tools/function-tool";
import { server } from "../plugins/server";
import type { TelemetryConfig } from "../telemetry";
import { createApp } from "./appkit";

export interface CreateAgentConfig {
  /** Single agent adapter (mutually exclusive with `agents`). Registered as "assistant". */
  adapter?: AgentAdapter | Promise<AgentAdapter>;
  /** Multiple named agents (mutually exclusive with `adapter`). */
  agents?: Record<string, AgentAdapter | Promise<AgentAdapter>>;
  /** Which agent to use when the client doesn't specify one. */
  defaultAgent?: string;
  /** Tool-providing plugins (analytics, files, genie, lakebase, etc.) */
  plugins?: PluginData<PluginConstructor, unknown, string>[];
  /** Server port. Defaults to DATABRICKS_APP_PORT or 8000. */
  port?: number;
  /** Server host. Defaults to FLASK_RUN_HOST or 0.0.0.0. */
  host?: string;
  /** Telemetry configuration. */
  telemetry?: TelemetryConfig;
  /** Cache configuration. */
  cache?: CacheConfig;
  /** Explicit tools (FunctionTool, HostedTool) alongside auto-discovered ToolProvider tools. */
  tools?: AgentTool[];
  /** Pre-configured WorkspaceClient. */
  client?: WorkspaceClient;
}

export interface AgentHandle {
  /** Register an additional agent at runtime. */
  registerAgent: (name: string, adapter: AgentAdapter) => void;
  /** Add function tools at runtime (HostedTools must be configured at setup). */
  addTools: (tools: FunctionTool[]) => void;
  /** Get all tool definitions available to agents. */
  getTools: () => AgentToolDefinition[];
  /** List threads for a user. */
  getThreads: (userId: string) => Promise<unknown>;
  /** Access to user-provided plugin APIs. */
  plugins: Record<string, any>;
}

/**
 * Creates an agent-powered app with batteries included.
 *
 * Wraps `createApp` with `server()` and `agent()` pre-configured.
 * Automatically starts an HTTP server with agent chat routes.
 *
 * For apps that need custom routes or manual server control,
 * use `createApp` with `server()` and `agent()` directly.
 *
 * @example Single agent
 * ```ts
 * import { createAgent, analytics } from "@databricks/appkit";
 * import { DatabricksAdapter } from "@databricks/appkit/agents/databricks";
 *
 * createAgent({
 *   plugins: [analytics()],
 *   adapter: DatabricksAdapter.fromServingEndpoint({
 *     workspaceClient: new WorkspaceClient({}),
 *     endpointName: "databricks-claude-sonnet-4-5",
 *     systemPrompt: "You are a data assistant...",
 *   }),
 * }).then(agent => {
 *   console.log("Tools:", agent.getTools());
 * });
 * ```
 *
 * @example Multiple agents
 * ```ts
 * createAgent({
 *   plugins: [analytics(), files()],
 *   agents: {
 *     assistant: DatabricksAdapter.fromServingEndpoint({ ... }),
 *     autocomplete: DatabricksAdapter.fromServingEndpoint({ ... }),
 *   },
 *   defaultAgent: "assistant",
 * });
 * ```
 */
/**
 * @deprecated Use `createAgent(def)` (pure factory) + `agents()` plugin +
 *   `createApp()` instead. The new shape separates agent *definition* from
 *   *app composition*. Re-exported as `createAgentApp` in the main package
 *   index for migration; will be removed in a future release.
 */
export async function createAgent(
  config: CreateAgentConfig = {},
): Promise<AgentHandle> {
  if (config.adapter && config.agents) {
    throw new Error(
      "createAgent: 'adapter' and 'agents' are mutually exclusive. " +
        "Use 'adapter' for a single agent or 'agents' for multiple.",
    );
  }

  let agents = config.adapter ? { assistant: config.adapter } : config.agents;

  // Default: if no adapter or agents provided, use DatabricksAdapter.fromModelServing()
  // which reads from DATABRICKS_AGENT_ENDPOINT env var. Config-file agents
  // (from config/agents/*.md) will also be loaded during agent plugin setup.
  if (!agents && !config.adapter) {
    try {
      const { DatabricksAdapter } = await import("../agents/databricks");
      agents = { assistant: DatabricksAdapter.fromModelServing() };
    } catch {
      // No adapter available — agent plugin will rely on config files
    }
  }

  const appkit = await createApp({
    plugins: [
      agent({
        agents,
        defaultAgent: config.defaultAgent,
        tools: config.tools,
      }),
      ...(config.plugins ?? []),
      server({
        autoStart: true,
        ...(config.port !== undefined && { port: config.port }),
        ...(config.host !== undefined && { host: config.host }),
      }),
    ],
    telemetry: config.telemetry,
    cache: config.cache,
    client: config.client,
  });

  const agentExports = (appkit as any).agent;
  const hiddenKeys = new Set(["agent", "server"]);

  const plugins: Record<string, any> = {};
  for (const [key, value] of Object.entries(appkit as Record<string, any>)) {
    if (!hiddenKeys.has(key)) {
      plugins[key] = value;
    }
  }

  return {
    registerAgent: agentExports.registerAgent,
    addTools: agentExports.addTools,
    getTools: agentExports.getTools,
    getThreads: agentExports.getThreads,
    plugins,
  };
}
