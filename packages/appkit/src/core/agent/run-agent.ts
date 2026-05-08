import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentEvent,
  AgentToolDefinition,
  Message,
  PluginConstructor,
  PluginData,
  ToolProvider,
} from "shared";
import { consumeAdapterStream } from "./consume-adapter-stream";
import { resolveToolkitFromProvider } from "./toolkit-resolver";
import {
  type FunctionTool,
  functionToolToDefinition,
  isFunctionTool,
} from "./tools/function-tool";
import { isHostedTool } from "./tools/hosted-tools";
import type {
  AgentDefinition,
  AgentTool,
  AgentTools,
  Plugins,
  PluginToolkitProvider,
} from "./types";
import { isToolkitEntry } from "./types";

export interface RunAgentInput {
  /** Seed messages for the run. Either a single user string or a full message list. */
  messages: string | Message[];
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * Optional plugin list. Required when `def.tools` is the function form
   * `(plugins) => Record<string, AgentTool>` and the function dereferences
   * any plugins. `runAgent` constructs a fresh instance per plugin and
   * dispatches tool calls against it as the service principal (no OBO —
   * there is no HTTP request in standalone mode).
   */
  plugins?: PluginData<PluginConstructor, unknown, string>[];
}

export interface RunAgentResult {
  /** Aggregated text output from all `message_delta` events. */
  text: string;
  /** Every event the adapter yielded, in order. Useful for inspection/tests. */
  events: AgentEvent[];
}

/**
 * Standalone agent execution without `createApp`. Resolves the adapter, binds
 * inline tools, and drives the adapter's `run()` loop to completion.
 *
 * Limitations vs. running through the agents() plugin:
 * - No OBO: there is no HTTP request, so plugin tools run as the service
 *   principal (when they work at all).
 * - Hosted tools (MCP) are not supported — they require a live MCP client
 *   that only exists inside the agents plugin.
 * - Sub-agents (`agents: { ... }` on the def) are executed as nested
 *   `runAgent` calls with no shared thread state.
 * - Plugin tools (used inside the function form via
 *   `plugins.<name>.toolkit(...)`) require passing `plugins: [...]` via
 *   `RunAgentInput`.
 */
export async function runAgent(
  def: AgentDefinition,
  input: RunAgentInput,
): Promise<RunAgentResult> {
  const adapter = await resolveAdapter(def);
  const messages = normalizeMessages(input.messages, def.instructions);
  const toolIndex = buildStandaloneToolIndex(def, input.plugins ?? []);
  const tools = Array.from(toolIndex.values()).map((e) => e.def);

  const signal = input.signal;

  const executeTool = async (name: string, args: unknown): Promise<unknown> => {
    const entry = toolIndex.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);
    if (entry.kind === "function") {
      return entry.tool.execute(args as Record<string, unknown>);
    }
    if (entry.kind === "toolkit") {
      return entry.provider.executeAgentTool(
        entry.localName,
        args as Record<string, unknown>,
        signal,
      );
    }
    if (entry.kind === "subagent") {
      const subInput: RunAgentInput = {
        messages:
          typeof args === "object" &&
          args !== null &&
          typeof (args as { input?: unknown }).input === "string"
            ? (args as { input: string }).input
            : JSON.stringify(args),
        signal,
        plugins: input.plugins,
      };
      const res = await runAgent(entry.agentDef, subInput);
      return res.text;
    }
    throw new Error(
      `runAgent: tool "${name}" is a ${entry.kind} tool. ` +
        "Hosted/MCP tools are only usable via createApp({ plugins: [..., agents(...)] }).",
    );
  };

  const events: AgentEvent[] = [];

  const stream = adapter.run(
    {
      messages,
      tools,
      threadId: randomUUID(),
      signal,
    },
    { executeTool, signal },
  );

  // Shared accumulation rule (deltas append, `message` replaces). The
  // `events` array is filled via the `onEvent` side effect so callers that
  // inspect the raw stream still get the full record.
  const text = await consumeAdapterStream(stream, {
    signal,
    onEvent: (event) => {
      events.push(event);
    },
  });

  return { text, events };
}

async function resolveAdapter(def: AgentDefinition): Promise<AgentAdapter> {
  const { model } = def;
  if (!model) {
    const { DatabricksAdapter } = await import("../../agents/databricks");
    return DatabricksAdapter.fromModelServing();
  }
  if (typeof model === "string") {
    const { DatabricksAdapter } = await import("../../agents/databricks");
    return DatabricksAdapter.fromModelServing(model);
  }
  return await model;
}

function normalizeMessages(
  input: string | Message[],
  instructions: string,
): Message[] {
  const systemMessage: Message = {
    id: "system",
    role: "system",
    content: instructions,
    createdAt: new Date(),
  };
  if (typeof input === "string") {
    return [
      systemMessage,
      {
        id: randomUUID(),
        role: "user",
        content: input,
        createdAt: new Date(),
      },
    ];
  }
  return [systemMessage, ...input];
}

type StandaloneEntry =
  | {
      kind: "function";
      def: AgentToolDefinition;
      tool: FunctionTool;
    }
  | {
      kind: "subagent";
      def: AgentToolDefinition;
      agentDef: AgentDefinition;
    }
  | {
      kind: "toolkit";
      def: AgentToolDefinition;
      provider: ToolProvider;
      pluginName: string;
      localName: string;
    }
  | {
      kind: "hosted";
      def: AgentToolDefinition;
    };

/**
 * Resolves `def.tools` (object or function form) and `def.agents`
 * (sub-agents) into a flat dispatch index. The function form is invoked
 * once per call against a {@link Plugins} map built lazily from
 * `input.plugins`; missing references throw with an `Available: …` listing.
 */
function buildStandaloneToolIndex(
  def: AgentDefinition,
  plugins: PluginData<PluginConstructor, unknown, string>[],
): Map<string, StandaloneEntry> {
  const index = new Map<string, StandaloneEntry>();
  const providerCache = new Map<string, ToolProvider>();
  const tools = resolveDefTools(def, plugins, providerCache);

  for (const [key, tool] of Object.entries(tools)) {
    index.set(key, classifyTool(key, tool, providerCache));
  }

  for (const [childKey, child] of Object.entries(def.agents ?? {})) {
    const toolName = `agent-${childKey}`;
    index.set(toolName, {
      kind: "subagent",
      agentDef: { ...child, name: child.name ?? childKey },
      def: {
        name: toolName,
        description:
          child.instructions.slice(0, 120) ||
          `Delegate to the ${childKey} sub-agent`,
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Message to send to the sub-agent.",
            },
          },
          required: ["input"],
        },
      },
    });
  }

  return index;
}

/**
 * Resolves `def.tools` to a plain record. The function form is invoked
 * with a typed {@link Plugins} map built lazily over `plugins`; each
 * `plugins.foo.toolkit(opts)` call constructs the underlying provider
 * (cached) on first access.
 */
function resolveDefTools(
  def: AgentDefinition,
  plugins: PluginData<PluginConstructor, unknown, string>[],
  providerCache: Map<string, ToolProvider>,
): AgentTools {
  if (typeof def.tools !== "function") {
    return def.tools ?? {};
  }
  const pluginsMap = buildStandalonePluginsMap(plugins, providerCache);
  try {
    return def.tools(pluginsMap);
  } catch (err) {
    const name = def.name ?? "<anonymous>";
    throw new Error(
      `runAgent: agent '${name}' tools(plugins) callback threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

/**
 * Builds the typed {@link Plugins} map passed to the function form of
 * `def.tools` in standalone mode. Plugin instances are constructed lazily
 * (only when the user actually calls `plugins.foo.toolkit(...)`) and
 * cached so the same instance is reused for dispatch downstream.
 */
function buildStandalonePluginsMap(
  plugins: PluginData<PluginConstructor, unknown, string>[],
  providerCache: Map<string, ToolProvider>,
): Plugins {
  const out: Record<string, PluginToolkitProvider> = {};
  for (const data of plugins) {
    out[data.name] = {
      toolkit: (opts) => {
        const provider = resolveStandaloneProvider(
          data.name,
          plugins,
          providerCache,
        );
        return resolveToolkitFromProvider(data.name, provider, opts);
      },
    };
  }
  return out as Plugins;
}

function classifyTool(
  key: string,
  tool: AgentTool,
  providerCache: Map<string, ToolProvider>,
): StandaloneEntry {
  if (isToolkitEntry(tool)) {
    // Toolkit entries inside the function form's returned record carry the
    // provider name they came from, so we can resolve the provider on
    // demand and dispatch through it. The cache is shared with the
    // pluginsMap path so the same instance is reused.
    const provider = providerCacheLookup(tool.pluginName, providerCache);
    return {
      kind: "toolkit",
      provider,
      pluginName: tool.pluginName,
      localName: tool.localName,
      def: { ...tool.def, name: key },
    };
  }
  if (isFunctionTool(tool)) {
    return {
      kind: "function",
      tool,
      def: { ...functionToolToDefinition(tool), name: key },
    };
  }
  if (isHostedTool(tool)) {
    // Hosted tools (e.g. MCP `mcpServer(...)`) need a live MCP client that
    // only exists inside the agents plugin's lifecycle. In standalone
    // `runAgent` they would have errored at dispatch time with a confusing
    // mid-conversation failure; reject them up front so misconfiguration
    // surfaces before the adapter sees the tool list.
    throw new Error(
      `runAgent: tool "${key}" is a hosted tool (type="${tool.type}") which is only supported via createApp({ plugins: [..., agents(...)] }). Standalone runAgent has no MCP client.`,
    );
  }
  throw new Error(`runAgent: unrecognized tool shape at key "${key}"`);
}

function providerCacheLookup(
  pluginName: string,
  cache: Map<string, ToolProvider>,
): ToolProvider {
  const cached = cache.get(pluginName);
  if (cached) return cached;
  throw new Error(
    `runAgent: tool refers to plugin '${pluginName}' but its instance was ` +
      "not initialised by tools(plugins). This usually means the function " +
      "form returned a stale ToolkitEntry without going through " +
      "plugins[...].toolkit().",
  );
}

/**
 * Lightweight `ToolProvider` shape check used by standalone `runAgent`.
 *
 * Distinct from `core/plugin-context.isToolProvider` which also requires
 * `asUser` (request-scoped, only meaningful when running inside `createApp`
 * with a live HTTP context). Standalone plugins are constructed without a
 * `WorkspaceClient` and have no request to scope to, so checking only the
 * two `ToolProvider` methods is the right narrowing here.
 */
function isStandaloneToolProvider(value: unknown): value is ToolProvider {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.getAgentTools === "function" &&
    typeof obj.executeAgentTool === "function"
  );
}

function resolveStandaloneProvider(
  pluginName: string,
  plugins: PluginData<PluginConstructor, unknown, string>[],
  cache: Map<string, ToolProvider>,
): ToolProvider {
  const cached = cache.get(pluginName);
  if (cached) return cached;

  const match = plugins.find((p) => p.name === pluginName);
  if (!match) {
    const available = plugins.map((p) => p.name).join(", ") || "(none)";
    throw new Error(
      `runAgent: agent tools(plugins) referenced plugin '${pluginName}', ` +
        "but that plugin is missing from RunAgentInput.plugins. " +
        `Available: ${available}.`,
    );
  }

  const instance = new match.plugin({
    ...(match.config ?? {}),
    name: pluginName,
  });
  if (!isStandaloneToolProvider(instance)) {
    throw new Error(
      `runAgent: plugin '${pluginName}' is not a ToolProvider ` +
        "(missing getAgentTools/executeAgentTool). Only ToolProvider plugins " +
        "are supported in standalone runAgent.",
    );
  }
  cache.set(pluginName, instance);
  return instance;
}
