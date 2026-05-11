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
import { createPluginsProxy } from "./plugins-map";
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
 * - **No OBO and no approval gate** — there is no HTTP request, so plugin
 *   tools run as the service principal. The agents-plugin approval gate
 *   that prompts for human confirmation on `effect: "write" | "update" |
 *   "destructive"` tools is also absent. LLM-controlled tool arguments
 *   flow straight through to the SP. Treat standalone runAgent as a
 *   trusted-prompt environment (CI, batch eval, internal scripts) — not
 *   as an exposed user-facing surface.
 * - **Hosted tools (MCP) are not supported** — they require a live MCP
 *   client that only exists inside the agents plugin's lifecycle.
 *   `runAgent` rejects them at index-build time with a clear error.
 * - **Sub-agents** (`agents: { ... }` on the def) are executed as nested
 *   `runAgent` calls with no shared thread state. Plugin instances ARE
 *   shared across the recursion (same cache as the parent).
 * - **Plugin tools** (used inside the function form via
 *   `plugins.<name>.toolkit(...)`) require passing `plugins: [...]` via
 *   `RunAgentInput`. Each plugin in that array is constructed once,
 *   `attachContext({})` and `await setup()` are called eagerly, and the
 *   resulting instance is shared across the top-level run and all
 *   sub-agent recursions. Plugins whose `setup()` requires runtime that
 *   only `createApp` provides (e.g. `WorkspaceClient`, `ServiceContext`,
 *   `PluginContext`) throw at standalone-init time with a clear "use
 *   createApp instead" message — not mid-stream.
 */
export async function runAgent(
  def: AgentDefinition,
  input: RunAgentInput,
): Promise<RunAgentResult> {
  // Single shared cache for the whole call graph: parent + every nested
  // sub-agent dispatch share constructed plugin instances. Without this,
  // each nested `runAgent` would build its own cache, re-instantiate every
  // plugin, and silently diverge in-instance state between parent and child
  // (e.g. query result caches, connection pools).
  const providerCache = new Map<string, ToolProvider>();
  await initStandalonePlugins(input.plugins ?? [], providerCache);
  return runAgentInternal(def, input, providerCache);
}

async function runAgentInternal(
  def: AgentDefinition,
  input: RunAgentInput,
  providerCache: Map<string, ToolProvider>,
): Promise<RunAgentResult> {
  const adapter = await resolveAdapter(def);
  const messages = normalizeMessages(input.messages, def.instructions);
  const toolIndex = buildStandaloneToolIndex(
    def,
    input.plugins ?? [],
    providerCache,
  );
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
      // Reuse the same `providerCache` so sub-agent plugin tools dispatch
      // through the same instances the parent constructed.
      const res = await runAgentInternal(
        entry.agentDef,
        subInput,
        providerCache,
      );
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

/**
 * Eagerly construct every plugin in `input.plugins`, run the standard
 * AppKit lifecycle (`attachContext({})` + `await setup()`), and populate
 * `cache`. Failures here surface BEFORE any adapter work — mid-stream
 * `getWorkspaceClient is not initialised`-style errors become a clear
 * startup failure naming the plugin and pointing the user at `createApp`.
 *
 * Plugins that don't need runtime context (no overridden `setup`, or one
 * that doesn't dereference `createApp`-only state) initialise cleanly and
 * standalone runAgent works as documented. Plugins like analytics/files
 * that depend on `WorkspaceClient` will throw the underlying error wrapped
 * with the migration hint.
 */
async function initStandalonePlugins(
  plugins: PluginData<PluginConstructor, unknown, string>[],
  cache: Map<string, ToolProvider>,
): Promise<void> {
  for (const data of plugins) {
    if (cache.has(data.name)) continue;
    const instance = new data.plugin({
      ...(data.config ?? {}),
      name: data.name,
    });
    if (!isStandaloneToolProvider(instance)) {
      throw new Error(
        `runAgent: plugin '${data.name}' is not a ToolProvider ` +
          "(missing getAgentTools/executeAgentTool). Only ToolProvider plugins " +
          "are supported in standalone runAgent.",
      );
    }
    if (
      typeof (instance as { attachContext?: unknown }).attachContext ===
      "function"
    ) {
      try {
        (
          instance as { attachContext: (deps: Record<string, unknown>) => void }
        ).attachContext({});
      } catch (err) {
        throw new Error(
          `runAgent: plugin '${data.name}' attachContext() failed in ` +
            "standalone mode. This plugin probably depends on createApp's " +
            "runtime (WorkspaceClient, ServiceContext, PluginContext). Run " +
            "via createApp({ plugins: [..., agents(...)] }) instead. " +
            `Cause: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }
    if (typeof (instance as { setup?: unknown }).setup === "function") {
      try {
        await (instance as { setup: () => Promise<void> | void }).setup();
      } catch (err) {
        throw new Error(
          `runAgent: plugin '${data.name}' setup() failed in standalone ` +
            "mode. This plugin probably depends on createApp's runtime " +
            "(WorkspaceClient, ServiceContext, PluginContext). Run via " +
            "createApp({ plugins: [..., agents(...)] }) instead. " +
            `Cause: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }
    cache.set(data.name, instance);
  }
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
 * once per call against a {@link Plugins} map drawn from the shared
 * `providerCache` populated by {@link initStandalonePlugins}. Missing
 * references throw a named "not registered" error via the proxy.
 */
function buildStandaloneToolIndex(
  def: AgentDefinition,
  plugins: PluginData<PluginConstructor, unknown, string>[],
  providerCache: Map<string, ToolProvider>,
): Map<string, StandaloneEntry> {
  const index = new Map<string, StandaloneEntry>();
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
 * with a typed {@link Plugins} map drawn from the pre-populated
 * `providerCache`; each `plugins.foo.toolkit(opts)` lookup hits the cache
 * directly (no construction at toolkit-call time).
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
 * `def.tools` in standalone mode. Reads pre-constructed instances from
 * `providerCache` (populated eagerly by {@link initStandalonePlugins})
 * and wraps the result in a Proxy so unknown plugin names produce a
 * named "not registered, Available: ..." error instead of bubbling up a
 * generic `TypeError: Cannot read properties of undefined`.
 */
function buildStandalonePluginsMap(
  plugins: PluginData<PluginConstructor, unknown, string>[],
  providerCache: Map<string, ToolProvider>,
): Plugins {
  const out: Record<string, PluginToolkitProvider> = {};
  for (const data of plugins) {
    const provider = providerCache.get(data.name);
    if (!provider) continue; // initStandalonePlugins should have set this
    out[data.name] = {
      toolkit: (opts) => resolveToolkitFromProvider(data.name, provider, opts),
    };
  }
  return createPluginsProxy(out, "runAgent: tools(plugins)");
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
  const available = Array.from(cache.keys()).join(", ") || "(none)";
  throw new Error(
    `runAgent: tool refers to plugin '${pluginName}', but no instance was ` +
      "initialised for that name. Add it to RunAgentInput.plugins, or — if " +
      "this came from a hand-rolled ToolkitEntry — go through " +
      `plugins[name].toolkit() instead. Available: ${available}.`,
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
