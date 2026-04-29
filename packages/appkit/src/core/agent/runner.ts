import type {
  AgentAdapter,
  AgentEvent,
  AgentToolDefinition,
  Message,
} from "shared";
import { consumeAdapterStream } from "./consume-adapter-stream";

/**
 * Execution strategy for a tool call. Lives behind {@link AgentRunner} so
 * the runner doesn't care whether the tool ends up dispatched via HTTP
 * plumbing (approval gate, OBO, MCP client) or by direct in-process call.
 *
 * The runner injects the adapter's per-invocation {@link AbortSignal} so
 * implementations can wire it through to long-running work.
 */
export interface ToolExecutor {
  execute(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}

interface AgentRunnerInput {
  messages: Message[];
  threadId: string;
}

interface AgentRunnerDeps {
  adapter: AgentAdapter;
  tools: AgentToolDefinition[];
  executeTool: ToolExecutor;
  signal: AbortSignal;
  /** Called for every event the adapter emits, in order. */
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Single execution loop for an AgentDefinition. Intentionally thin — its
 * only job is to drive the adapter to completion and surface events.
 *
 * Tool-dispatch policy (approval gating, per-user budget, OBO, MCP)
 * is owned by the injected {@link ToolExecutor}. The plugin layer wires an
 * `HttpToolExecutor` for the streaming chat path; `runAgent()` wires a
 * `StandaloneToolExecutor` for in-process scripts.
 */
export class AgentRunner {
  constructor(private deps: AgentRunnerDeps) {}

  async run(input: AgentRunnerInput): Promise<string> {
    const { adapter, tools, executeTool, signal, onEvent } = this.deps;
    return consumeAdapterStream(
      adapter.run(
        {
          messages: input.messages,
          tools,
          threadId: input.threadId,
          signal,
        },
        {
          executeTool: (name, args) => executeTool.execute(name, args, signal),
          signal,
        },
      ),
      { signal, onEvent },
    );
  }
}
