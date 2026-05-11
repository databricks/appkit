/**
 * Server-side state for the human-in-the-loop approval gate on
 * `destructive: true` agent tool calls.
 *
 * Lifecycle:
 *
 * 1. `wait(...)` is called from inside `executeTool` when a destructive tool
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
  resolve: (decision: ApprovalDecision) => void;
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
  }): Promise<ApprovalDecision> {
    const { approvalId, streamId, userId, timeoutMs } = args;
    return new Promise<ApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(approvalId)) {
          resolve("deny");
        }
      }, timeoutMs);
      this.pending.set(approvalId, {
        resolve,
        userId,
        streamId,
        timeout,
      });
    });
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
    p.resolve(decision);
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
        p.resolve("deny");
      }
    }
  }

  /** Cancel every pending gate. Used at plugin shutdown. */
  abortAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout);
      this.pending.delete(id);
      p.resolve("deny");
    }
  }

  /** Number of pending approvals (test/diagnostic helper). */
  get size(): number {
    return this.pending.size;
  }
}
