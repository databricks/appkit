/**
 * Server-side state for the client-tool round-trip: a deferred-promise gate
 * that pauses an agent's tool dispatch until the browser POSTs a result
 * (or until the configured timeout elapses).
 *
 * Mirrors {@link ToolApprovalGate} in shape and security invariants:
 *
 * 1. `wait(...)` is called from inside `dispatchToolCall` when a UI-registered
 *    tool is about to execute. A `Pending` record is registered and a timer
 *    is scheduled for auto-error. The returned promise is what blocks the
 *    adapter until the result arrives.
 * 2. The client receives an `appkit.client_tool_call` SSE event carrying the
 *    `callId` + `streamId` and POSTs the outcome to
 *    `POST /chat/client-tool-result`. The route calls
 *    {@link ClientToolGate.submit} which resolves the pending promise and
 *    clears the timer.
 * 3. If no submit arrives within `timeoutMs`, the timer fires and the
 *    promise resolves with a structured timeout error.
 *
 * Security invariants:
 *
 * - `submit` verifies that the caller's user id matches the user who
 *   initiated the stream. Mismatches are rejected without resolving the
 *   pending promise — this prevents a second user from completing another
 *   user's UI tool call.
 * - `abortStream(streamId)` cancels every pending gate for a stream and
 *   resolves each one with a structured "stream aborted" error. Used when
 *   the enclosing stream is cancelled or the plugin is shutting down.
 *
 * The promise never rejects; outcomes are surfaced as discriminated unions
 * so the dispatch site can hand the result/error straight back to the LLM
 * loop without an exception detour through the adapter.
 */
export type ClientToolOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "error"; error: string };

interface Pending {
  resolve: (outcome: ClientToolOutcome) => void;
  userId: string;
  streamId: string;
  toolName: string;
  timeout: ReturnType<typeof setTimeout>;
}

type ClientToolSubmitResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "forbidden" };

export class ClientToolGate {
  private pending = new Map<string, Pending>();

  /**
   * Register a pending client-tool call and return a promise that resolves
   * with a structured outcome. Never rejects — timeouts and aborts surface
   * as `{ kind: "error" }`.
   */
  wait(args: {
    callId: string;
    streamId: string;
    userId: string;
    toolName: string;
    timeoutMs: number;
  }): Promise<ClientToolOutcome> {
    const { callId, streamId, userId, toolName, timeoutMs } = args;
    return new Promise<ClientToolOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(callId)) {
          resolve({
            kind: "error",
            error: `Client tool '${toolName}' did not respond within ${timeoutMs}ms`,
          });
        }
      }, timeoutMs);
      this.pending.set(callId, {
        resolve,
        userId,
        streamId,
        toolName,
        timeout,
      });
    });
  }

  /**
   * Settle a client-tool call with the browser's result or a structured
   * error. Returns:
   * - `{ ok: true }` if the pending record existed, the userId matched, and
   *   the promise was resolved.
   * - `{ ok: false, reason: "unknown" }` if no pending record matches the id.
   * - `{ ok: false, reason: "forbidden" }` if the userId does not match the
   *   user who initiated the stream.
   */
  submit(args: {
    callId: string;
    userId: string;
    outcome: ClientToolOutcome;
  }): ClientToolSubmitResult {
    const { callId, userId, outcome } = args;
    const p = this.pending.get(callId);
    if (!p) return { ok: false, reason: "unknown" };
    if (p.userId !== userId) return { ok: false, reason: "forbidden" };
    clearTimeout(p.timeout);
    this.pending.delete(callId);
    p.resolve(outcome);
    return { ok: true };
  }

  /**
   * Cancel a single pending gate by call id (e.g. the enclosing chat run was
   * aborted while the call was in flight). No-op if already settled. Used by
   * the unified channel: calls are keyed by session, not by chat run, so a
   * chat abort must cancel its own in-flight calls individually rather than
   * by stream id.
   */
  cancel(callId: string): void {
    const p = this.pending.get(callId);
    if (!p) return;
    clearTimeout(p.timeout);
    this.pending.delete(callId);
    p.resolve({
      kind: "error",
      error: `Client tool '${p.toolName}' aborted before the browser responded`,
    });
  }

  /**
   * Cancel all pending gates for a specific stream (e.g., when the user
   * cancels the stream or the request unwinds). Each gate resolves with a
   * structured error so the adapter unwinds cleanly.
   */
  abortStream(streamId: string): void {
    for (const [id, p] of this.pending) {
      if (p.streamId === streamId) {
        clearTimeout(p.timeout);
        this.pending.delete(id);
        p.resolve({
          kind: "error",
          error: `Client tool '${p.toolName}' aborted: stream ended before the browser responded`,
        });
      }
    }
  }

  /** Cancel every pending gate. Used at plugin shutdown. */
  abortAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout);
      this.pending.delete(id);
      p.resolve({
        kind: "error",
        error: `Client tool '${p.toolName}' aborted: agents plugin shutting down`,
      });
    }
  }

  /** Number of pending client-tool calls (test/diagnostic helper). */
  get size(): number {
    return this.pending.size;
  }
}
