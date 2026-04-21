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

/** Agent backed by the default Supervisor API adapter. */
export interface ModelAgentDescriptor {
  /** Model name (e.g. "databricks-claude-sonnet-4-5"). */
  model: string;
  /** System instructions for this agent. */
  instructions?: string;
  /** Tools in Supervisor API format, passed inline with every request. */
  tools?: SupervisorApiHostedTool[];
  adapter?: never;
}

/** Agent backed by a custom adapter. */
export interface CustomAdapterAgentDescriptor {
  /** Pre-built adapter instance (or promise). */
  adapter: AgentAdapter | Promise<AgentAdapter>;
  model?: never;
  instructions?: never;
  tools?: never;
}

/** Per-agent entry inside the `agents` record. */
export type AgentDescriptor =
  | ModelAgentDescriptor
  | CustomAdapterAgentDescriptor;

interface CreateAgentBaseConfig {
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
  /** Pre-configured WorkspaceClient. Falls back to `new WorkspaceClient({})` when omitted. */
  client?: WorkspaceClient;
}

/** Single agent using the default Supervisor API adapter. */
export interface SingleAgentConfig extends CreateAgentBaseConfig {
  /** Model name (e.g. "databricks-claude-sonnet-4-5"). */
  model: string;
  /** System instructions for the agent. */
  instructions?: string;
  /** Tools in Supervisor API format, passed inline with every request. */
  tools?: SupervisorApiHostedTool[];
  agents?: never;
  defaultAgent?: never;
  adapter?: never;
}

/** Multiple named agents, each using the default Supervisor API adapter. */
export interface MultiAgentConfig extends CreateAgentBaseConfig {
  /** Named agent descriptors. Each entry creates a Supervisor API adapter. */
  agents: Record<string, AgentDescriptor>;
  /** Which agent to use when the client doesn't specify one. Defaults to the first entry. */
  defaultAgent?: string;
  model?: never;
  instructions?: never;
  tools?: never;
  adapter?: never;
}

/** Custom adapter — full control over the agent runtime. */
export interface CustomAdapterConfig extends CreateAgentBaseConfig {
  /** Custom adapter instance (or promise). Bypasses the default Supervisor API adapter. */
  adapter: AgentAdapter | Promise<AgentAdapter>;
  model?: never;
  instructions?: never;
  tools?: never;
  agents?: never;
  defaultAgent?: never;
}

export type CreateAgentConfig =
  | SingleAgentConfig
  | MultiAgentConfig
  | CustomAdapterConfig;

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
 * @example Single agent (shorthand)
 * ```ts
 * createAgent({
 *   plugins: [analytics()],
 *   model: "databricks-claude-sonnet-4-5",
 *   instructions: "You are a data assistant...",
 *   tools: [{ type: "genie_space", genie_space: { id: "...", description: "..." } }],
 * });
 * ```
 *
 * @example Multiple agents (mix of default and custom adapters)
 * ```ts
 * createAgent({
 *   plugins: [analytics(), files()],
 *   agents: {
 *     assistant: { model: "databricks-claude-sonnet-4-5", instructions: "..." },
 *     helper: { adapter: new VercelAIAdapter({ model }) },
 *   },
 *   defaultAgent: "assistant",
 * });
 * ```
 *
 * @example Custom adapter
 * ```ts
 * createAgent({
 *   plugins: [analytics()],
 *   adapter: new VercelAIAdapter({ model }),
 * });
 * ```
 */
export async function createAgent(
  config: CreateAgentConfig,
): Promise<AgentHandle> {
  validateConfig(config);

  let resolvedAgents: Record<string, AgentAdapter | Promise<AgentAdapter>>;
  let defaultAgent: string | undefined;

  if (config.adapter) {
    resolvedAgents = { assistant: config.adapter };
  } else if (config.agents) {
    const adapters: Record<string, AgentAdapter | Promise<AgentAdapter>> = {};
    for (const [name, desc] of Object.entries(config.agents)) {
      if (desc.adapter) {
        adapters[name] = desc.adapter;
      } else {
        adapters[name] = buildDefaultAdapter(
          config,
          desc.model,
          desc.instructions,
          desc.tools,
        );
      }
    }
    resolvedAgents = adapters;
    defaultAgent = config.defaultAgent;
  } else {
    resolvedAgents = {
      assistant: buildDefaultAdapter(
        config,
        config.model as string,
        config.instructions,
        config.tools,
      ),
    };
  }

  const appkit = await createApp({
    plugins: [
      agent({
        agents: resolvedAgents,
        defaultAgent,
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

function validateConfig(config: CreateAgentConfig) {
  const modes = [
    config.model !== undefined,
    config.agents !== undefined,
    config.adapter !== undefined,
  ].filter(Boolean).length;

  if (modes > 1) {
    throw new Error(
      "createAgent: 'model', 'agents', and 'adapter' are mutually exclusive. " +
        "Use 'model' for a single agent, 'agents' for multiple, or 'adapter' for a custom adapter.",
    );
  }

  if (modes === 0) {
    throw new Error(
      "createAgent: one of 'model', 'agents', or 'adapter' is required.",
    );
  }

  if (config.defaultAgent && !config.agents) {
    throw new Error("createAgent: 'defaultAgent' requires 'agents' to be set.");
  }
}

async function buildDefaultAdapter(
  config: CreateAgentBaseConfig,
  model: string,
  instructions?: string,
  tools?: SupervisorApiHostedTool[],
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
    instructions,
    tools,
  });
}
