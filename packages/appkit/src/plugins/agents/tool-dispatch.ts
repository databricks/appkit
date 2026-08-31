import { randomUUID } from "node:crypto";

import type express from "express";
import type { AgentRunContext, Message, ResponseStreamEvent } from "shared";

import type { AppKitMcpClient } from "../../connectors/mcp";
import { consumeAdapterStream } from "../../core/agent/consume-adapter-stream";
import { normalizeToolResult } from "../../core/agent/normalize-result";
import type {
  BaseSystemPromptOption,
  RegisteredAgent,
  ResolvedToolEntry,
} from "../../core/agent/types";
import type { PluginContext } from "../../core/plugin-context";
import { buildAdapterExtensions } from "./adapter-extensions";
import { requiresApproval } from "./approval";
import type { EventChannel } from "./event-channel";
import type { AgentEventTranslator } from "./event-translator";
import { traceTool } from "./mlflow";
import { composePromptForAgent } from "./prompt";
import type { ToolApprovalGate } from "./tool-approval-gate";

/**
 * Per-stream state shared between the top-level `executeTool` and any
 * `runSubAgent` calls below it. Carrying the budget counter, abort signal,
 * approval policy, and event-channel through one object is what lets the
 * sub-agent path enforce the same limits and approval gate as the parent.
 *
 * Without this shared state the sub-agent path silently bypassed both the
 * tool-call budget and the destructive-tool approval gate.
 */
export interface RunState {
  req: express.Request;
  userId: string;
  requestId: string;
  abortController: AbortController;
  signal: AbortSignal;
  approvalPolicy: { requireForDestructive: boolean; timeoutMs: number };
  limits: {
    maxConcurrentStreamsPerUser: number;
    maxToolCalls: number;
    maxSubAgentDepth: number;
    toolCallTimeoutMs: number;
  };
  translator: AgentEventTranslator;
  outboundEvents: EventChannel<ResponseStreamEvent>;
  /** Boxed mutable counter shared across parent + all sub-agent dispatches. */
  toolCallsUsed: { count: number };
}

/**
 * Plugin-instance collaborators the dispatch path needs. Passed as one object
 * so `dispatchToolCall`/`runSubAgent` stay free functions with a bounded
 * interface instead of reaching into the plugin. `getMcpClient` is a thunk so
 * a client connected after this object is built is still seen.
 */
export interface ToolDispatchDeps {
  approvalGate: ToolApprovalGate;
  context: PluginContext | undefined;
  getMcpClient: () => AppKitMcpClient | null;
  agents: Map<string, RegisteredAgent>;
  dispatchSkillTool: (
    entry: Extract<ResolvedToolEntry, { source: "skill" }>,
    args: unknown,
  ) => Promise<string>;
  pluginName: string;
  baseSystemPrompt: BaseSystemPromptOption | undefined;
}

/**
 * Dispatch a single tool call from either the top-level adapter or a
 * sub-agent. Centralising this in one function is what makes the budget
 * counter, approval gate, and abort signal observe sub-agent activity:
 * `runSubAgent` reuses the same `runState` and so increments the same
 * counter and emits approval events through the same channel.
 *
 * `depth` is the current sub-agent recursion depth (0 at the top level).
 * It is forwarded to `runSubAgent` when the dispatched entry is itself a
 * sub-agent, so depth limits remain enforced.
 */
export async function dispatchToolCall(
  deps: ToolDispatchDeps,
  runState: RunState,
  toolIndex: Map<string, ResolvedToolEntry>,
  name: string,
  args: unknown,
  depth: number,
): Promise<unknown> {
  if (runState.toolCallsUsed.count >= runState.limits.maxToolCalls) {
    runState.abortController.abort(
      new Error(
        `Tool-call budget exhausted (limit ${runState.limits.maxToolCalls}).`,
      ),
    );
    throw new Error(
      `Tool-call budget exhausted (limit ${runState.limits.maxToolCalls}). Raise agents({ limits: { maxToolCalls } }) or review the agent's tool-selection logic.`,
    );
  }
  runState.toolCallsUsed.count++;

  const entry = toolIndex.get(name);
  if (!entry) throw new Error(`Unknown tool: ${name}`);

  if (
    runState.approvalPolicy.requireForDestructive &&
    requiresApproval(entry.def.annotations)
  ) {
    const approvalId = randomUUID();
    for (const ev of runState.translator.translate({
      type: "approval_pending",
      approvalId,
      streamId: runState.requestId,
      toolName: name,
      args,
      annotations: entry.def.annotations,
    })) {
      runState.outboundEvents.push(ev);
    }
    const decision = await deps.approvalGate.wait({
      approvalId,
      streamId: runState.requestId,
      userId: runState.userId,
      timeoutMs: runState.approvalPolicy.timeoutMs,
    });
    if (decision === "deny") {
      return `Tool execution denied by user approval gate (tool: ${name}).`;
    }
  }

  // Traced from here so the span covers execution only, not the approval
  // wait above (which is human latency).
  const toolResult = await traceTool(name, args, async () => {
    let result: unknown;
    if (entry.source === "toolkit") {
      if (!deps.context) {
        throw new Error(
          "Plugin tool execution requires PluginContext; this should never happen through createApp",
        );
      }
      result = await deps.context.executeTool(
        runState.req,
        entry.pluginName,
        entry.localName,
        args,
        runState.signal,
        runState.limits.toolCallTimeoutMs,
      );
    } else if (entry.source === "function") {
      // Function tools declare their parameters as a JSON-object schema,
      // so adapters always serialize `args` as an object. A non-object
      // value here means the upstream model emitted malformed tool-call
      // JSON; surface a clear error rather than silently passing through
      // a wrong-shape value the tool will then choke on.
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error(
          `Function tool '${name}' received non-object arguments (got ${args === null ? "null" : Array.isArray(args) ? "array" : typeof args}); expected a JSON object.`,
        );
      }
      result = await entry.functionTool.execute(
        args as Record<string, unknown>,
      );
    } else if (entry.source === "mcp") {
      const mcpClient = deps.getMcpClient();
      if (!mcpClient) throw new Error("MCP client not connected");
      const oboToken = runState.req.headers["x-forwarded-access-token"];
      const mcpAuth =
        typeof oboToken === "string"
          ? { Authorization: `Bearer ${oboToken}` }
          : undefined;
      result = await mcpClient.callTool(entry.mcpToolName, args, mcpAuth);
    } else if (entry.source === "subagent") {
      const childAgent = deps.agents.get(entry.agentName);
      if (!childAgent)
        throw new Error(`Sub-agent not found: ${entry.agentName}`);
      result = await runSubAgent(deps, runState, childAgent, args, depth + 1);
    } else if (entry.source === "hosted-supervisor") {
      // Defense-in-depth: should never fire. Hosted-supervisor entries are
      // routed via `AgentInput.extensions` and the SA endpoint executes
      // them server-side; their `def` is filtered out of the adapter's
      // `tools` array, so the model never sees a callable schema for them.
      // If we reach here, the agent is paired with a non-SA adapter that
      // somehow surfaced the placeholder def to the model — surface a
      // clear error rather than crash later in `normalizeToolResult`.
      throw new Error(
        `Tool '${name}' is a hosted-supervisor tool and cannot be invoked from the Node process. ` +
          "It is executed server-side by the Databricks AI Gateway and is only reachable when the agent's model is a Supervisor API adapter.",
      );
    } else if (entry.source === "skill") {
      result = await deps.dispatchSkillTool(entry, args);
    }

    return result;
  });

  return normalizeToolResult(toolResult);
}

/**
 * Runs a sub-agent in response to an `agent-<key>` tool call. Returns the
 * concatenated text output to hand back to the parent adapter as the tool
 * result.
 *
 * `depth` starts at 1 for a top-level sub-agent invocation and increments on
 * each nested call. Depths exceeding `limits.maxSubAgentDepth` are rejected
 * before any adapter work.
 *
 * Sub-agent tool calls run through `dispatchToolCall` with the same
 * `runState` as the parent — the budget counter and approval gate are
 * therefore enforced for every nested call, not only at the top level.
 */
export async function runSubAgent(
  deps: ToolDispatchDeps,
  runState: RunState,
  child: RegisteredAgent,
  args: unknown,
  depth: number,
): Promise<string> {
  if (depth > runState.limits.maxSubAgentDepth) {
    throw new Error(
      `Sub-agent depth exceeded (limit ${runState.limits.maxSubAgentDepth}). ` +
        `Raise agents({ limits: { maxSubAgentDepth } }) or break the delegation cycle.`,
    );
  }

  const input =
    typeof args === "object" &&
    args !== null &&
    typeof (args as { input?: unknown }).input === "string"
      ? (args as { input: string }).input
      : JSON.stringify(args);
  // Same filter as the top-level path: hosted-supervisor `def` is a
  // placeholder, not a callable function — exclude from the adapter's
  // `tools` array. The specs are routed via `extensions` instead.
  const childTools = Array.from(child.toolIndex.values())
    .filter((e) => e.source !== "hosted-supervisor")
    .map((e) => e.def);

  const childExecute = (name: string, childArgs: unknown): Promise<unknown> =>
    dispatchToolCall(deps, runState, child.toolIndex, name, childArgs, depth);

  const runContext: AgentRunContext = {
    executeTool: childExecute,
    signal: runState.signal,
  };

  const pluginNames = deps.context
    ? deps.context
        .getPluginNames()
        .filter((n) => n !== deps.pluginName && n !== "server")
    : [];
  const systemPrompt = composePromptForAgent(child, deps.baseSystemPrompt, {
    agentName: child.name,
    pluginNames,
    toolNames: childTools.map((t) => t.name),
  });

  const messages: Message[] = [
    {
      id: "system",
      role: "system",
      content: systemPrompt,
      createdAt: new Date(),
    },
    {
      id: randomUUID(),
      role: "user",
      content: input,
      createdAt: new Date(),
    },
  ];

  return consumeAdapterStream(
    child.adapter.run(
      {
        messages,
        tools: childTools,
        threadId: randomUUID(),
        signal: runState.signal,
        extensions: buildAdapterExtensions(child.toolIndex),
      },
      runContext,
    ),
    {
      signal: runState.signal,
      // Forward every sub-agent event into the parent's outbound SSE
      // stream so the client sees nested tool_call / tool_result events
      // (UI-action tools like apply_filter / highlight_period rely on
      // this) and the sub-agent's streaming text as it's generated.
      //
      // `metadata` is the one exception: sub-agents have their own
      // threadId, and forwarding it would overwrite the parent's
      // thread state on the client and break multi-turn continuity.
      // Approval-pending events emitted by `dispatchToolCall` already
      // reach `outboundEvents` directly, so they are not routed here.
      onEvent: (event) => {
        if (event.type === "metadata") return;
        for (const translated of runState.translator.translate(event)) {
          runState.outboundEvents.push(translated);
        }
      },
    },
  );
}
