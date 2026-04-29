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
import { isFromPluginMarker } from "./from-plugin";
import { AgentRunner } from "./runner";
import {
  type StandaloneEntry,
  StandaloneToolExecutor,
} from "./standalone-tool-executor";
import { resolveToolkitFromProvider } from "./toolkit-resolver";
import {
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

  // `runAgent` historically allowed callers to omit a signal. Synthesize one
  // so AgentRunner / ToolExecutor can rely on always having a real signal.
  const signal = input.signal ?? new AbortController().signal;

  const events: AgentEvent[] = [];

  const executor = new StandaloneToolExecutor(
    toolIndex,
    async (subDef, subInput, subSignal) => {
      const res = await runAgent(subDef, {
        messages: subInput,
        signal: subSignal,
        plugins: input.plugins,
      });
      return res.text;
    },
  );

  const runner = new AgentRunner({
    adapter,
    tools,
    executeTool: executor,
    signal,
    onEvent: (event) => events.push(event),
  });

  const text = await runner.run({ messages, threadId: randomUUID() });
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
    return {
      kind: "hosted",
      def: {
        name: key,
        description: `Hosted tool: ${tool.type}`,
        parameters: { type: "object", properties: {} },
      },
    };
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
  const provider = instance as unknown as ToolProvider;
  if (
    typeof (provider as { getAgentTools?: unknown }).getAgentTools !==
      "function" ||
    typeof (provider as { executeAgentTool?: unknown }).executeAgentTool !==
      "function"
  ) {
    throw new Error(
      `runAgent: plugin '${pluginName}' is not a ToolProvider ` +
        "(missing getAgentTools/executeAgentTool). Only ToolProvider plugins " +
        "are supported via fromPlugin() in runAgent.",
    );
  }
  cache.set(pluginName, provider);
  return provider;
}
