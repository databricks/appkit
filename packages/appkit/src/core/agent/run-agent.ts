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
import type { z } from "zod";

import {
  isSupervisorTool,
  SUPERVISOR_EXTENSION_KEY,
  type SupervisorTool,
} from "../../agents/supervisor-api";
import { createLogger } from "../../logging/logger";
import { consumeAdapterStream } from "./consume-adapter-stream";
import { createPluginsProxy } from "./plugins-map";
import {
  resolveStructuredOutput,
  type StructuringPass,
} from "./structured-output";
import { resolveToolkitFromProvider } from "./toolkit-resolver";
import {
  type FunctionTool,
  functionToolToDefinition,
  isFunctionTool,
} from "./tools/function-tool";
import { isHostedTool } from "./tools/hosted-tools";
import { toToolJSONSchema } from "./tools/json-schema";
import type {
  AgentDefinition,
  AgentTool,
  AgentTools,
  Plugins,
  PluginToolkitProvider,
} from "./types";
import { isToolkitEntry } from "./types";

const logger = createLogger("agent:run-agent");

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

/** Per-call options for {@link runAgent}. */
export interface RunAgentOptions<TOutput = unknown> {
  /**
   * Structured-output schema override for this call. Takes precedence over the
   * agent's own `output` schema. When either is set, `runAgent` validates the
   * final answer and populates {@link RunAgentResult.output}, throwing a
   * `StructuredOutputError` if it can't produce a valid object.
   */
  output?: z.ZodType<TOutput>;
}

export interface RunAgentResult<TOutput = string> {
  /** Aggregated text output from all `message_delta` events. */
  text: string;
  /** Every event the adapter yielded, in order. Useful for inspection/tests. */
  events: AgentEvent[];
  /**
   * Parsed, schema-validated object — present only when the agent (or the
   * per-call override) declared an `output` schema. Statically typed via
   * `z.infer` when the agent was built with `createAgent({ output })`.
   */
  output?: TOutput;
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
// Per-call schema override drives the result type via z.infer.
export function runAgent<S extends z.ZodType>(
  def: AgentDefinition<unknown>,
  input: RunAgentInput,
  options: RunAgentOptions<z.infer<S>> & { output: S },
): Promise<RunAgentResult<z.infer<S>>>;
// No override — the result type comes from the agent's own `output` schema.
export function runAgent<TOutput = string>(
  def: AgentDefinition<TOutput>,
  input: RunAgentInput,
): Promise<RunAgentResult<TOutput>>;
export async function runAgent(
  def: AgentDefinition<unknown>,
  input: RunAgentInput,
  options?: RunAgentOptions,
): Promise<RunAgentResult<unknown>> {
  // Single shared cache for the whole call graph: parent + every nested
  // sub-agent dispatch share constructed plugin instances. Without this,
  // each nested `runAgent` would build its own cache, re-instantiate every
  // plugin, and silently diverge in-instance state between parent and child
  // (e.g. query result caches, connection pools).
  const providerCache = new Map<string, ToolProvider>();
  await initStandalonePlugins(input.plugins ?? [], providerCache);

  const schema = options?.output ?? def.output;
  // Pass the schema into the main run so a tool-free agent gets
  // `response_format` inline (no wasted round-trip); the adapter ignores it
  // when tools are present. Sub-agent recursions never receive it.
  const mainOutputSchema = schema ? toToolJSONSchema(schema) : undefined;
  const { text, events, adapter, hadTools, baseMessages } =
    await runAgentInternal(def, input, providerCache, mainOutputSchema);

  if (!schema) return { text, events };

  const output = await resolveStructuredOutput({
    schema,
    baseMessages,
    finalText: text,
    hadTools,
    runStructuringPass: buildStructuringPass(adapter, schema),
    signal: input.signal,
  });
  return { text, events, output };
}

/**
 * Builds a {@link StructuringPass}: one tool-free, schema-constrained
 * `adapter.run()`, consumed to its final text. `executeTool` throws — a
 * tool-free run never dispatches one; if it somehow does, that's a bug we
 * want surfaced, not swallowed.
 */
function buildStructuringPass(
  adapter: AgentAdapter,
  schema: z.ZodType,
): StructuringPass {
  const outputSchema = toToolJSONSchema(schema);
  return (messages, signal) =>
    consumeAdapterStream(
      adapter.run(
        { messages, tools: [], threadId: randomUUID(), signal, outputSchema },
        {
          executeTool: () => {
            throw new Error(
              "runAgent: structuring pass is tool-free and must not call a tool",
            );
          },
          signal,
        },
      ),
      { signal },
    );
}

interface RawRunResult {
  text: string;
  events: AgentEvent[];
  /** Adapter used for the run — reused for the structuring pass. */
  adapter: AgentAdapter;
  /** Whether the run exposed tools (tool-having answers need a structuring pass). */
  hadTools: boolean;
  /** Normalized system + input messages the run saw (structuring-pass seed). */
  baseMessages: Message[];
}

async function runAgentInternal(
  def: AgentDefinition<unknown>,
  input: RunAgentInput,
  providerCache: Map<string, ToolProvider>,
  mainOutputSchema?: Record<string, unknown>,
): Promise<RawRunResult> {
  const adapter = await resolveAdapter(def);
  const messages = normalizeMessages(input.messages, def.instructions);
  const toolIndex = buildStandaloneToolIndex(
    def,
    input.plugins ?? [],
    providerCache,
  );
  // Hosted-supervisor entries are routed via `extensions`, not as callable
  // tools — exclude their placeholder `def` from the wire `tools` array.
  const tools = Array.from(toolIndex.values())
    .filter((e) => e.kind !== "hosted-supervisor")
    .map((e) => e.def);

  warnOnCapabilityMismatch(def.name ?? "<anonymous>", adapter, toolIndex);

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
    if (entry.kind === "hosted-supervisor") {
      // Defense-in-depth: should never fire. The placeholder def is
      // filtered out of `tools` above, so the model never sees a callable
      // schema for hosted-supervisor entries. If we ever reach here, the
      // model was somehow handed the def and tried to invoke it directly.
      throw new Error(
        `runAgent: tool "${name}" is a hosted-supervisor tool, executed server-side by the Databricks AI Gateway. It must not be invoked from the Node process.`,
      );
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
      extensions: buildStandaloneExtensions(toolIndex),
      outputSchema: mainOutputSchema,
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

  return {
    text,
    events,
    adapter,
    hadTools: tools.length > 0,
    baseMessages: messages,
  };
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

async function resolveAdapter(
  def: AgentDefinition<unknown>,
): Promise<AgentAdapter> {
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
    }
  | {
      /**
       * Adapter-side hosted tool. Standalone `runAgent` accepts these
       * (unlike MCP hosted tools, which need a live MCP client) because
       * the adapter has everything it needs to execute them server-side:
       * the spec travels via `AgentInput.extensions` and the SA endpoint
       * runs the tool loop. Enables batch-eval / CI use of supervisor
       * agents without `createApp`.
       */
      kind: "hosted-supervisor";
      def: AgentToolDefinition;
      spec: SupervisorTool;
    };

/**
 * Resolves `def.tools` (object or function form) and `def.agents`
 * (sub-agents) into a flat dispatch index. The function form is invoked
 * once per call against a {@link Plugins} map drawn from the shared
 * `providerCache` populated by {@link initStandalonePlugins}. Missing
 * references throw a named "not registered" error via the proxy.
 */
function buildStandaloneToolIndex(
  def: AgentDefinition<unknown>,
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
  def: AgentDefinition<unknown>,
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
  // Supervisor-API hosted tools work in standalone mode: the adapter
  // executes them server-side via `AgentInput.extensions`, no MCP client
  // required. Must come BEFORE the `isHostedTool` MCP rejection — the two
  // predicates classify disjoint values (`isSupervisorTool` matches the
  // `__kind` tag; `isHostedTool` matches the wire-format `type` field),
  // but the placement makes the intent explicit.
  if (isSupervisorTool(tool)) {
    return {
      kind: "hosted-supervisor",
      spec: tool.spec,
      def: {
        name: key,
        description: supervisorToolDescription(tool.spec),
        parameters: { type: "object", properties: {} },
      },
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

/** Mirrors `agents.ts`'s `supervisorToolDescription`. */
function supervisorToolDescription(spec: SupervisorTool): string {
  switch (spec.type) {
    case "genie_space":
      return spec.genie_space.description;
    case "uc_function":
      return spec.uc_function.description;
    case "knowledge_assistant":
      return spec.knowledge_assistant.description;
    case "app":
      return spec.app.description;
    case "uc_connection":
      return spec.uc_connection.description;
  }
}

/** Mirrors `agents.ts`'s `buildAdapterExtensions`. */
function buildStandaloneExtensions(
  toolIndex: Map<string, StandaloneEntry>,
): Readonly<Record<string, unknown>> | undefined {
  const supervisorSpecs: SupervisorTool[] = [];
  for (const entry of toolIndex.values()) {
    if (entry.kind === "hosted-supervisor") {
      supervisorSpecs.push(entry.spec);
    }
  }
  if (supervisorSpecs.length === 0) return undefined;
  return {
    [SUPERVISOR_EXTENSION_KEY]: { hostedTools: supervisorSpecs },
  };
}

/**
 * Mirrors the agents-plugin capability warning so standalone `runAgent`
 * produces the same diagnostic when adapter capabilities don't match the
 * tool index. Warn-not-throw: doesn't abort batch evals.
 */
function warnOnCapabilityMismatch(
  agentName: string,
  adapter: AgentAdapter,
  toolIndex: Map<string, StandaloneEntry>,
): void {
  const accepted = new Set(adapter.acceptsExtensions ?? []);

  const hostedSupervisorKeys: string[] = [];
  const inputToolKeys: string[] = [];
  for (const [key, entry] of toolIndex) {
    if (entry.kind === "hosted-supervisor") {
      hostedSupervisorKeys.push(key);
    } else {
      inputToolKeys.push(key);
    }
  }

  if (
    hostedSupervisorKeys.length > 0 &&
    !accepted.has(SUPERVISOR_EXTENSION_KEY)
  ) {
    logger.warn(
      `Agent '${agentName}' declares hosted-supervisor tools (${hostedSupervisorKeys.join(", ")}) ` +
        "but its model adapter does not accept the 'databricks.supervisor' extension. " +
        "Pair them with `DatabricksAdapter.fromSupervisorApi(...)`, or remove them.",
    );
  }

  if (adapter.consumesInputTools === false && inputToolKeys.length > 0) {
    logger.warn(
      `Agent '${agentName}' declares function tools / sub-agents (${inputToolKeys.join(", ")}) ` +
        "but its model adapter does not consume input.tools. These tools will not be exposed to the model.",
    );
  }
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
