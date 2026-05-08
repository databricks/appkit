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
import { isFromPluginMarker } from "./from-plugin";
import { resolveToolkitFromProvider } from "./toolkit-resolver";
import {
  type FunctionTool,
  functionToolToDefinition,
  isFunctionTool,
} from "./tools/function-tool";
import { isHostedTool } from "./tools/hosted-tools";
import type { AgentDefinition, AgentTool, ToolkitEntry } from "./types";
import { isToolkitEntry } from "./types";

export interface RunAgentInput {
  /** Seed messages for the run. Either a single user string or a full message list. */
  messages: string | Message[];
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * Optional plugin list used to resolve `fromPlugin` markers in `def.tools`.
   * Required when the def contains any `...fromPlugin(factory)` spreads;
   * ignored otherwise. `runAgent` constructs a fresh instance per plugin
   * and dispatches tool calls against it as the service principal (no
   * OBO — there is no HTTP request in standalone mode).
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
 * - Plugin tools (`fromPlugin` markers or `ToolkitEntry` spreads) require
 *   passing `plugins: [...]` via `RunAgentInput`.
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
 * Resolves `def.tools` (string-keyed entries + symbol-keyed `fromPlugin`
 * markers) and `def.agents` (sub-agents) into a flat dispatch index.
 * Symbol-keyed markers are resolved against `plugins`; missing references
 * throw with an `Available: …` listing.
 */
function buildStandaloneToolIndex(
  def: AgentDefinition,
  plugins: PluginData<PluginConstructor, unknown, string>[],
): Map<string, StandaloneEntry> {
  const index = new Map<string, StandaloneEntry>();
  const tools = def.tools;

  const symbolKeys = tools ? Object.getOwnPropertySymbols(tools) : [];
  if (symbolKeys.length > 0) {
    const providerCache = new Map<string, ToolProvider>();
    for (const sym of symbolKeys) {
      const marker = (tools as Record<symbol, unknown>)[sym];
      if (!isFromPluginMarker(marker)) continue;

      const provider = resolveStandaloneProvider(
        marker.pluginName,
        plugins,
        providerCache,
      );
      const entries = resolveToolkitFromProvider(
        marker.pluginName,
        provider,
        marker.opts,
      );
      for (const [key, entry] of Object.entries(entries)) {
        index.set(key, {
          kind: "toolkit",
          provider,
          pluginName: entry.pluginName,
          localName: entry.localName,
          def: { ...entry.def, name: key },
        });
      }
    }
  }

  if (tools) {
    for (const [key, tool] of Object.entries(tools)) {
      index.set(key, classifyTool(key, tool));
    }
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

function classifyTool(key: string, tool: AgentTool): StandaloneEntry {
  if (isToolkitEntry(tool)) {
    return toolkitEntryToStandalone(key, tool);
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

/**
 * Pre-`fromPlugin` code could reach a `ToolkitEntry` by calling
 * `.toolkit()` at module scope (which requires an instance). Those entries
 * still flow through `def.tools` but without a provider we can dispatch
 * against — runAgent cannot execute them and errors clearly.
 */
function toolkitEntryToStandalone(
  key: string,
  entry: ToolkitEntry,
): StandaloneEntry {
  const def: AgentToolDefinition = { ...entry.def, name: key };
  return {
    kind: "hosted",
    def: {
      ...def,
      description:
        `${def.description ?? ""} ` +
        `[runAgent: this ToolkitEntry refers to plugin '${entry.pluginName}' but ` +
        "runAgent cannot dispatch it without the plugin instance. Pass the " +
        "plugin via plugins: [...] and use fromPlugin(factory) instead of " +
        ".toolkit() spreads.]".trim(),
    },
  };
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
      `runAgent: agent references plugin '${pluginName}' via fromPlugin(), but ` +
        "that plugin is missing from RunAgentInput.plugins. " +
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
        "are supported via fromPlugin() in runAgent.",
    );
  }
  cache.set(pluginName, instance);
  return instance;
}
