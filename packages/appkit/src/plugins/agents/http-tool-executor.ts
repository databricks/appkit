import { randomUUID } from "node:crypto";
import type express from "express";
import type { AgentEvent, ResponseStreamEvent, ToolAnnotations } from "shared";
import type { AppKitMcpClient } from "../../connectors/mcp";
import { normalizeToolResult } from "../../core/agent/normalize-result";
import type { ToolExecutor } from "../../core/agent/runner";
import { dispatchToolCall } from "../../core/agent/tool-dispatch";
import type { ResolvedToolEntry } from "../../core/agent/types";
import type { PluginContext } from "../../core/plugin-context";
import type { EventChannel } from "./event-channel";
import type { AgentEventTranslator } from "./event-translator";
import type { ToolApprovalGate } from "./tool-approval-gate";

/**
 * Decision returned by the approval check. `null` means "no gate fires"
 * (tool isn't gated, or policy disabled gating). `"approve"` / `"deny"`
 * mirror the user's submission via `POST /approve`.
 */
export type ApprovalDecision = "approve" | "deny" | null;

/**
 * Approval-check function reused by both the parent stream's executor and
 * any sub-agent executors it spawns. Lifted to a callable so sub-agents
 * can share the parent's translator + outboundEvents + approvalGate.
 */
export type ApprovalCheck = (
  entry: ResolvedToolEntry,
  args: unknown,
) => Promise<ApprovalDecision>;

/**
 * Sub-agent runner injected by the plugin. Returns the sub-agent's
 * concatenated text output to hand back to the parent adapter as the
 * tool result. Hidden behind a callback so the executor doesn't need to
 * import the plugin class (cycle).
 */
type RunSubAgentFn = (
  agentName: string,
  args: unknown,
  signal: AbortSignal,
  forwardEvent: (e: AgentEvent) => void,
  checkApproval: ApprovalCheck,
) => Promise<string>;

/**
 * Mutable per-run tool-call budget. Shared by reference between the
 * top-level executor and any sub-agent executors so `maxToolCalls` is
 * enforced across the whole run, not per-agent.
 */
export interface ToolBudget {
  used: number;
  limit: number;
}

interface HttpToolExecutorDeps {
  toolIndex: Map<string, ResolvedToolEntry>;
  /** Approval policy as resolved from `agents({ approval: ... })`. */
  approvalPolicy: { requireForDestructive: boolean; timeoutMs: number };
  approvalGate: ToolApprovalGate;
  /** Translator used to emit `approval_pending` to the SSE stream. */
  translator: AgentEventTranslator;
  /** Channel the SSE stream drains. Approval events are pushed here. */
  outboundEvents: EventChannel<ResponseStreamEvent>;
  /** Aborted on budget exhaustion to unwind the adapter promptly. */
  abortController: AbortController;
  /**
   * Shared tool-call budget. Pass the same object to every executor in the
   * run (top-level + sub-agents) so the cap is global. Pass `null` for
   * sub-agent executors that should not count against the budget — only
   * the parent enforces, mirroring the original closure's behaviour.
   */
  budget: ToolBudget | null;
  /** OBO source: forwarded to dispatchToolCall for plugin-tool dispatch. */
  req: express.Request;
  /** SSE stream id (used for approval gate scoping + telemetry). */
  streamId: string;
  /** Authenticated user id, scoped per-stream by `_handleApprove`. */
  userId: string;
  /** PluginContext for OBO tool dispatch. May be undefined in tests. */
  pluginContext: PluginContext | undefined;
  /** MCP client for hosted-tool dispatch. May be null pre-connect. */
  mcpClient: AppKitMcpClient | null;
  /** Plugin-supplied factory that runs a sub-agent. */
  runSubAgent: RunSubAgentFn;
}

/**
 * HTTP-path tool executor for the streaming chat surface.
 *
 * Wraps the same logic that used to live as a closure inside
 * `_streamAgent`: per-run budget, the approval gate, OBO dispatch via
 * {@link dispatchToolCall}, sub-agent recursion, and event forwarding.
 *
 * Sub-agents share the parent's `translator`, `outboundEvents`,
 * `approvalGate`, and `abortController` (so a sub-agent's destructive
 * tool surfaces an `approval_pending` event on the parent's SSE stream
 * and a sub-agent's budget exhaustion aborts the whole run). The
 * `budget` is null for sub-agents so they don't double-count against
 * the top-level cap — the parent already incremented when it dispatched
 * the `agent-<key>` call.
 */
export class HttpToolExecutor implements ToolExecutor {
  constructor(private deps: HttpToolExecutorDeps) {}

  async execute(
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { budget, abortController } = this.deps;

    if (budget) {
      if (budget.used >= budget.limit) {
        abortController.abort(
          new Error(`Tool-call budget exhausted (limit ${budget.limit}).`),
        );
        throw new Error(
          `Tool-call budget exhausted (limit ${budget.limit}). ` +
            "Raise agents({ limits: { maxToolCalls } }) or review the agent's tool-selection logic.",
        );
      }
      budget.used++;
    }

    const entry = this.deps.toolIndex.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);

    const decision = await this.checkApproval(entry, args);
    if (decision === "deny") {
      return `Tool execution denied by user approval gate (tool: ${name}).`;
    }

    // Forward events from nested sub-agents into the parent's outbound SSE
    // stream so the client sees inner tool calls AND the sub-agent's
    // streaming text as it's generated. Without this the user stares at
    // "thinking…" for the full duration of the sub-agent run.
    //
    // The one exception is `metadata`: sub-agents have their own threadId,
    // and forwarding it would overwrite the parent's thread state on the
    // client and break multi-turn continuity.
    //
    // `approval_pending` is not emitted by adapters directly — it comes
    // through `checkApproval()` which already pushes to the parent's
    // outboundEvents — so sub-agent destructive approvals surface
    // independently of this forwarder.
    const forwardSubAgentEvent = (ev: AgentEvent): void => {
      if (ev.type === "metadata") return;
      for (const translated of this.deps.translator.translate(ev)) {
        this.deps.outboundEvents.push(translated);
      }
    };

    const raw = await dispatchToolCall(entry, args, {
      req: this.deps.req,
      signal,
      pluginContext: this.deps.pluginContext,
      mcpClient: this.deps.mcpClient,
      runSubAgent: (agentName, subArgs) =>
        this.deps.runSubAgent(
          agentName,
          subArgs,
          signal,
          forwardSubAgentEvent,
          this.checkApproval,
        ),
    });
    return normalizeToolResult(raw);
  }

  /**
   * Approval gate hook. Bound as an arrow so sub-agent executors can pass
   * it through to {@link RunSubAgentFn} and the gate fires using the
   * parent's translator + outboundEvents + approvalGate. Public so tests
   * can drive it directly.
   */
  readonly checkApproval: ApprovalCheck = async (entry, args) => {
    const {
      approvalPolicy,
      approvalGate,
      translator,
      outboundEvents,
      streamId,
      userId,
    } = this.deps;
    if (!approvalPolicy.requireForDestructive) return null;
    if (!isDestructiveToolEntry(entry)) return null;
    const approvalId = randomUUID();
    for (const ev of translator.translate({
      type: "approval_pending",
      approvalId,
      streamId,
      toolName: entry.def.name,
      args,
      annotations: combinedToolAnnotations(entry),
    })) {
      outboundEvents.push(ev);
    }
    return approvalGate.wait({
      approvalId,
      streamId,
      userId,
      timeoutMs: approvalPolicy.timeoutMs,
    });
  };
}

/**
 * True when the tool should go through the approval gate. Historically
 * scoped to `destructive: true` — hence the name — but now also fires for
 * the semantic `effect` enum on {@link ToolAnnotations}. Any effect that
 * mutates the world (`write` | `update` | `destructive`) gates; `read` and
 * unannotated tools do not. `def.annotations` is the normal path; for
 * `function` tools we also read `functionTool.annotations` so a mismatch
 * between the spread def and the original {@link FunctionTool} cannot drop
 * the hint.
 */
function isDestructiveToolEntry(entry: ResolvedToolEntry): boolean {
  const defAnn = entry.def.annotations;
  const fnAnn =
    entry.source === "function" ? entry.functionTool.annotations : undefined;

  const effect = defAnn?.effect ?? fnAnn?.effect;
  if (effect === "write" || effect === "update" || effect === "destructive") {
    return true;
  }
  if (defAnn?.destructive === true) return true;
  if (fnAnn?.destructive === true) return true;
  return false;
}

/** Merged annotations for the approval SSE payload (client UI + debugging). */
function combinedToolAnnotations(
  entry: ResolvedToolEntry,
): ToolAnnotations | undefined {
  if (entry.source === "function") {
    const merged: ToolAnnotations = {
      ...entry.functionTool.annotations,
      ...entry.def.annotations,
    };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }
  return entry.def.annotations;
}
