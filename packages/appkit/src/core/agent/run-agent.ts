import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentEvent,
  AgentToolDefinition,
  Message,
} from "shared";
import { consumeAdapterStream } from "./consume-adapter-stream";
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
 * - Plugin tools (`ToolkitEntry`) are not supported — they require a live
 *   `PluginContext` that only exists when registered in a `createApp`
 *   instance. This function throws a clear error if encountered.
 * - Sub-agents (`agents: { ... }` on the def) are executed as nested
 *   `runAgent` calls with no shared thread state.
 */
export async function runAgent(
  def: AgentDefinition,
  input: RunAgentInput,
): Promise<RunAgentResult> {
  const adapter = await resolveAdapter(def);
  const messages = normalizeMessages(input.messages, def.instructions);
  const toolIndex = buildStandaloneToolIndex(def);
  const tools = Array.from(toolIndex.values()).map((e) => e.def);

  const signal = input.signal;

  const executeTool = async (name: string, args: unknown): Promise<unknown> => {
    const entry = toolIndex.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);
    if (entry.kind === "function") {
      return entry.tool.execute(args as Record<string, unknown>);
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
      };
      const res = await runAgent(entry.agentDef, subInput);
      return res.text;
    }
    throw new Error(
      `runAgent: tool "${name}" is a ${entry.kind} tool. ` +
        "Plugin toolkits and MCP tools are only usable via createApp({ plugins: [..., agents(...)] }).",
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
      entry: ToolkitEntry;
    }
  | {
      kind: "hosted";
      def: AgentToolDefinition;
    };

function buildStandaloneToolIndex(
  def: AgentDefinition,
): Map<string, StandaloneEntry> {
  const index = new Map<string, StandaloneEntry>();

  for (const [key, tool] of Object.entries(def.tools ?? {})) {
    index.set(key, classifyTool(key, tool));
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
    return { kind: "toolkit", def: { ...tool.def, name: key }, entry: tool };
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
