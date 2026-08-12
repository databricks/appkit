import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ToolEffect } from "shared";
import { captureTraceValue } from "../../telemetry/agent-tracing";

const tracer = () => trace.getTracer("@databricks/appkit-agent-tracing");

type ApprovalState =
  | "approved"
  | "denied"
  | "timed_out"
  | "cancelled"
  | "failed";

export async function traceApprovalWait<T>(
  input: {
    approvalId: string;
    toolName: string;
    effect?: ToolEffect;
    args: unknown;
  },
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    `${input.toolName} approval`,
    {
      attributes: {
        "mlflow.spanType": "CHAIN",
        "appkit.approval.id": input.approvalId,
        "appkit.approval.tool_name": input.toolName,
        ...(input.effect ? { "appkit.approval.effect": input.effect } : {}),
      },
    },
    async (span) => {
      const startedAt = Date.now();
      setCapturedAttribute(span, "mlflow.spanInputs", input.args);
      try {
        const result = await operation(span);
        setCapturedAttribute(span, "mlflow.spanOutputs", result);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setAttribute("appkit.approval.decision", "error");
        span.setAttribute("appkit.approval.state", "failed");
        recordSafeFailure(span, error, "Approval wait failed");
        throw error;
      } finally {
        span.setAttribute(
          "appkit.approval.duration_ms",
          Math.max(0, Date.now() - startedAt),
        );
        span.end();
      }
    },
  );
}

function setCapturedAttribute(span: Span, key: string, value: unknown): void {
  const captured = captureTraceValue(value);
  span.setAttribute(key, captured.value);
  span.setAttribute(`${key}.original_bytes`, captured.originalBytes);
  span.setAttribute(`${key}.sha256`, captured.sha256);
  span.setAttribute(`${key}.truncated`, captured.truncated);
}

function recordSafeFailure(
  span: Span,
  error: unknown,
  publicMessage: string,
): void {
  const failure = captureTraceValue(
    {
      error:
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error"),
    },
    { redactKeys: ["error"] },
  );
  span.setAttribute("appkit.error", failure.value);
  span.setAttribute("mlflow.spanOutputs", failure.value);
  span.setAttribute("mlflow.spanOutputs.original_bytes", failure.originalBytes);
  span.setAttribute("mlflow.spanOutputs.sha256", failure.sha256);
  span.setAttribute("mlflow.spanOutputs.truncated", failure.truncated);
  span.recordException({ name: "Error", message: publicMessage });
  span.setStatus({ code: SpanStatusCode.ERROR, message: publicMessage });
}

/**
 * Server-side state for the human-in-the-loop approval gate on mutating
 * agent tool calls — tools annotated with `effect: "write" | "update" |
 * "destructive"` (preferred) or the legacy `destructive: true` boolean.
 *
 * Lifecycle:
 *
 * 1. `wait(...)` is called from inside `executeTool` when a mutating tool
 *    is about to execute. A `Pending` record is registered and a timer is
 *    scheduled for auto-deny. The returned promise is what blocks the
 *    adapter until the decision arrives.
 * 2. The client receives an `appkit.approval_pending` SSE event carrying the
 *    `approvalId` + `streamId` and posts a decision to `POST /chat/approve`.
 *    The route calls {@link ToolApprovalGate.submit} which resolves the
 *    pending promise and clears the timer.
 * 3. If no submit arrives within `timeoutMs`, the timer fires and the
 *    promise resolves with `"deny"`.
 *
 * Security invariants:
 *
 * - `submit` verifies that the decider's user id matches the user who
 *   initiated the stream (set by `wait`). Mismatches are rejected without
 *   resolving the pending promise — this prevents a second user from
 *   approving (or denying) another user's destructive action.
 * - `abort(streamId)` cancels every pending gate for a stream and denies
 *   each one. Used when the enclosing stream is cancelled or the plugin is
 *   shutting down.
 */
type ApprovalDecision = "approve" | "deny";

interface Pending {
  settle: (decision: ApprovalDecision, state: ApprovalState) => void;
  userId: string;
  streamId: string;
  timeout: ReturnType<typeof setTimeout>;
}

type ApprovalSubmitResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "forbidden" };

export class ToolApprovalGate {
  private pending = new Map<string, Pending>();

  /**
   * Register a pending approval and return a promise that resolves with the
   * user's decision or with `"deny"` when the timeout elapses. The returned
   * promise never rejects.
   */
  wait(args: {
    approvalId: string;
    streamId: string;
    userId: string;
    timeoutMs: number;
    toolName?: string;
    effect?: ToolEffect;
    args?: unknown;
  }): Promise<ApprovalDecision> {
    const {
      approvalId,
      streamId,
      userId,
      timeoutMs,
      toolName = "unknown",
      effect,
    } = args;
    return traceApprovalWait(
      { approvalId, toolName, effect, args: args.args },
      (span) =>
        new Promise<ApprovalDecision>((resolve) => {
          const settle = (decision: ApprovalDecision, state: ApprovalState) => {
            span.setAttribute("appkit.approval.decision", decision);
            span.setAttribute("appkit.approval.state", state);
            resolve(decision);
          };
          const timeout = setTimeout(() => {
            if (this.pending.delete(approvalId)) {
              settle("deny", "timed_out");
            }
          }, timeoutMs);
          this.pending.set(approvalId, {
            settle,
            userId,
            streamId,
            timeout,
          });
        }),
    );
  }

  /**
   * Settle an approval with a user decision. Returns:
   * - `{ ok: true }` if the pending record existed, the userId matched, and
   *   the promise was resolved.
   * - `{ ok: false, reason: "unknown" }` if no pending record matches the id.
   * - `{ ok: false, reason: "forbidden" }` if the userId does not match the
   *   user who initiated the stream.
   */
  submit(args: {
    approvalId: string;
    userId: string;
    decision: ApprovalDecision;
  }): ApprovalSubmitResult {
    const { approvalId, userId, decision } = args;
    const p = this.pending.get(approvalId);
    if (!p) return { ok: false, reason: "unknown" };
    if (p.userId !== userId) return { ok: false, reason: "forbidden" };
    clearTimeout(p.timeout);
    this.pending.delete(approvalId);
    p.settle(decision, decision === "approve" ? "approved" : "denied");
    return { ok: true };
  }

  /**
   * Cancel all pending gates for a specific stream (e.g., when the user
   * cancels the stream). Each gate resolves with `"deny"` so the adapter
   * unwinds cleanly.
   */
  abortStream(streamId: string): void {
    for (const [id, p] of this.pending) {
      if (p.streamId === streamId) {
        clearTimeout(p.timeout);
        this.pending.delete(id);
        p.settle("deny", "cancelled");
      }
    }
  }

  /** Cancel every pending gate. Used at plugin shutdown. */
  abortAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout);
      this.pending.delete(id);
      p.settle("deny", "cancelled");
    }
  }

  /** Number of pending approvals (test/diagnostic helper). */
  get size(): number {
    return this.pending.size;
  }
}
