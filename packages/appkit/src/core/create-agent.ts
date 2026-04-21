import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type {
  AgentAdapter,
  AgentToolDefinition,
  CacheConfig,
  PluginConstructor,
  PluginData,
} from "shared";
import type { SupervisorApiHostedTool } from "../agents/responses";
import { agent } from "../plugins/agent";
import type { FunctionTool } from "../plugins/agent/tools/function-tool";
import { server } from "../plugins/server";
import type { TelemetryConfig } from "../telemetry";
import { createApp } from "./appkit";

export interface CreateAgentConfig {
  /** Tool-providing plugins (analytics, files, genie, lakebase, etc.) */
  plugins?: PluginData<PluginConstructor, unknown, string>[];
  /** Model name for the default Supervisor API adapter (e.g. "databricks-claude-sonnet-4-5"). Ignored when `adapter` is provided. */
  model?: string;
  /** System instructions for the default Supervisor API adapter. Ignored when `adapter` is provided. */
  instructions?: string;
  /** Tools in Supervisor API format (genie_space, uc_function, app, etc.). Passed inline with every request. */
  tools?: SupervisorApiHostedTool[];
  /** Custom adapter — when provided, bypasses the default Supervisor API adapter. */
  adapter?: AgentAdapter | Promise<AgentAdapter>;
  /** Server port. Defaults to DATABRICKS_APP_PORT or 8000. */
  port?: number;
  /** Server host. Defaults to FLASK_RUN_HOST or 0.0.0.0. */
  host?: string;
  /** Telemetry configuration. */
  telemetry?: TelemetryConfig;
  /** Cache configuration. */
  cache?: CacheConfig;
  /** Pre-configured WorkspaceClient. Falls back to `new WorkspaceClient({})` when omitted. */
  client?: WorkspaceClient;
}

export interface AgentHandle {
  /** Register an additional agent at runtime. */
  registerAgent: (name: string, adapter: AgentAdapter) => void;
  /** Add function tools at runtime. */
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
 * When no `adapter` is provided, a `SupervisorApiAdapter` is created
 * automatically using `model`, `instructions`, and `tools` from config.
 *
 * @example Default Supervisor API adapter
 * ```ts
 * import { createAgent, analytics } from "@databricks/appkit";
 *
 * createAgent({
 *   plugins: [analytics()],
 *   model: "databricks-claude-sonnet-4-5",
 *   instructions: "You are a data assistant...",
 *   tools: [
 *     { type: "genie_space", genie_space: { id: "...", description: "..." } },
 *   ],
 * });
 * ```
 *
 * @example Custom adapter
 * ```ts
 * import { createAgent } from "@databricks/appkit";
 * import { VercelAIAdapter } from "@databricks/appkit/agents/vercel-ai";
 *
 * createAgent({
 *   plugins: [analytics()],
 *   adapter: new VercelAIAdapter({ model }),
 * });
 * ```
 */
export async function createAgent(
  config: CreateAgentConfig,
): Promise<AgentHandle> {
  let resolvedAdapter: AgentAdapter | Promise<AgentAdapter>;

  if (config.adapter) {
    resolvedAdapter = config.adapter;
  } else {
    if (!config.model) {
      throw new Error(
        "createAgent: 'model' is required when no custom 'adapter' is provided.",
      );
    }
    resolvedAdapter = buildDefaultAdapter(config, config.model);
  }

  const appkit = await createApp({
    plugins: [
      agent({
        agents: { assistant: resolvedAdapter },
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

async function buildDefaultAdapter(
  config: CreateAgentConfig,
  model: string,
): Promise<AgentAdapter> {
  const { SupervisorApiAdapter } = await import("../agents/responses");

  let workspaceClient: { config: any };
  if (config.client) {
    workspaceClient = config.client;
  } else {
    const { WorkspaceClient } = await import("@databricks/sdk-experimental");
    workspaceClient = new WorkspaceClient({});
  }

  return SupervisorApiAdapter.create({
    workspaceClient,
    model,
    instructions: config.instructions,
    tools: config.tools,
  });
}
