import type { AgentToolDefinition, ToolProvider } from "shared";
import type { ToolExecutor } from "./runner";
import type { FunctionTool } from "./tools/function-tool";
import type { AgentDefinition } from "./types";

/**
 * Tool entry shape used by `runAgent`'s in-process dispatcher. Distinct
 * from {@link import("./types").ResolvedToolEntry} because the standalone
 * path holds live `provider`/`agentDef` references at index-build time
 * (no PluginContext to resolve from at dispatch time).
 */
export type StandaloneEntry =
  | { kind: "function"; def: AgentToolDefinition; tool: FunctionTool }
  | { kind: "subagent"; def: AgentToolDefinition; agentDef: AgentDefinition }
  | {
      kind: "toolkit";
      def: AgentToolDefinition;
      provider: ToolProvider;
      pluginName: string;
      localName: string;
    }
  | { kind: "hosted"; def: AgentToolDefinition };

/**
 * In-process tool executor for {@link import("./run-agent").runAgent}.
 *
 * No approval gate, no per-user budget, no OBO — there is no HTTP
 * request in standalone mode. Hosted/MCP tools error with a clear
 * message because they require a live MCP client owned by the
 * `agents()` plugin.
 *
 * Sub-agent recursion delegates back to the caller (which is `runAgent`
 * itself); this keeps the executor free of a circular import on the
 * top-level entry point.
 */
export class StandaloneToolExecutor implements ToolExecutor {
  constructor(
    private readonly toolIndex: Map<string, StandaloneEntry>,
    private readonly subAgentRunner: (
      def: AgentDefinition,
      input: string,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {}

  async execute(
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const entry = this.toolIndex.get(name);
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
      const sub =
        typeof args === "object" &&
        args !== null &&
        typeof (args as { input?: unknown }).input === "string"
          ? (args as { input: string }).input
          : JSON.stringify(args);
      return this.subAgentRunner(entry.agentDef, sub, signal);
    }
    throw new Error(
      `runAgent: tool "${name}" is a ${entry.kind} tool. ` +
        "Hosted/MCP tools are only usable via createApp({ plugins: [..., agents(...)] }).",
    );
  }
}
