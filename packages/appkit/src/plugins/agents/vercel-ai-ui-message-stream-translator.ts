import { randomUUID } from "node:crypto";
import type { AgentEvent } from "shared";
import type { AgentEventStreamTranslator } from "./translator";

/**
 * Vercel AI SDK UI Message Stream wire chunks consumed by `@ai-sdk/react`'s
 * `useChat`. We declare the subset we emit locally rather than importing
 * from `ai` because that package is an optional peer dependency of AppKit.
 *
 * See {@link https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocols} for the
 * authoritative protocol definition.
 */
export type VercelAIUIMessageChunk =
  | { type: "start"; messageId?: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool-output-available";
      toolCallId: string;
      output: unknown;
    }
  | {
      type: "tool-output-error";
      toolCallId: string;
      errorText: string;
    }
  | { type: "error"; errorText: string }
  | {
      type: "message-metadata";
      messageMetadata: Record<string, unknown>;
    }
  | {
      // Custom data part. The AppKit chat UI uses `data-approval-pending`
      // to render the destructive-tool approval card. The `id` makes the
      // part idempotent on the client (re-renders don't duplicate cards).
      type: `data-${string}`;
      id?: string;
      data: unknown;
      transient?: boolean;
    }
  | { type: "finish" };

/**
 * Translates AppKit's internal {@link AgentEvent} stream into Vercel AI SDK
 * UI Message Stream chunks consumed by `@ai-sdk/react`'s `useChat`.
 *
 * Stateful: one instance per streaming request. Manages lazy lifecycle for
 * the two streamable item kinds the protocol defines:
 *
 * - **text**: opened on the first `message_delta`, closed (`text-end`)
 *   before any non-text event (tool call, tool result, error) or
 *   `finalize()`. Each open span carries a stable `id` so deltas can be
 *   correlated on the client.
 * - **reasoning**: same lifecycle as text but for `thinking` events.
 *
 * `start` is emitted exactly once on the first translated event so the
 * client can establish the message id up front.
 *
 * Approval gates ride as a `data-approval-pending` data part keyed by
 * `approvalId` — the client matches the matching `POST /approve` decision
 * back via the existing `streamId`/`approvalId` pair.
 */
export class VercelAIUIMessageStreamTranslator
  implements AgentEventStreamTranslator<VercelAIUIMessageChunk>
{
  private startEmitted = false;
  private currentTextId: string | null = null;
  private currentReasoningId: string | null = null;
  private finalized = false;

  translate(event: AgentEvent): VercelAIUIMessageChunk[] {
    const out: VercelAIUIMessageChunk[] = [];
    this.maybeEmitStart(out);

    switch (event.type) {
      case "message_delta":
        this.closeReasoning(out);
        this.openTextIfNeeded(out);
        out.push({
          type: "text-delta",
          id: this.currentTextId as string,
          delta: event.content,
        });
        return out;

      case "message":
        // Adapter delivered a fully-materialised message in one shot. If a
        // streaming text span is already open, append the content as a
        // final delta so the on-the-wire text is identical to the
        // accumulated deltas; otherwise emit a one-shot delta wrapped in
        // start/end.
        this.closeReasoning(out);
        this.openTextIfNeeded(out);
        out.push({
          type: "text-delta",
          id: this.currentTextId as string,
          delta: event.content,
        });
        this.closeText(out);
        return out;

      case "thinking":
        this.closeText(out);
        this.openReasoningIfNeeded(out);
        out.push({
          type: "reasoning-delta",
          id: this.currentReasoningId as string,
          delta: event.content,
        });
        return out;

      case "tool_call":
        this.closeText(out);
        this.closeReasoning(out);
        out.push({
          type: "tool-input-available",
          toolCallId: event.callId,
          toolName: event.name,
          input: event.args,
        });
        return out;

      case "tool_result":
        this.closeText(out);
        this.closeReasoning(out);
        if (event.error !== undefined) {
          out.push({
            type: "tool-output-error",
            toolCallId: event.callId,
            errorText: event.error,
          });
        } else {
          out.push({
            type: "tool-output-available",
            toolCallId: event.callId,
            output: event.result,
          });
        }
        return out;

      case "metadata":
        // AppKit-internal `metadata` events surface things like the
        // server-allocated thread id. Forward as `message-metadata` so the
        // client gets it without bespoke wire shapes.
        out.push({
          type: "message-metadata",
          messageMetadata: event.data,
        });
        return out;

      case "approval_pending":
        // Custom data part — does NOT close the open text/reasoning span,
        // because the agent loop is paused on the approval gate and may
        // resume the same span once the user decides.
        out.push({
          type: "data-approval-pending",
          id: event.approvalId,
          data: {
            approvalId: event.approvalId,
            streamId: event.streamId,
            toolName: event.toolName,
            args: event.args,
            annotations: event.annotations,
          },
        });
        return out;

      case "status":
        return this.handleStatus(event.status, event.error, out);
    }
  }

  finalize(): VercelAIUIMessageChunk[] {
    if (this.finalized) return [];
    this.finalized = true;

    const out: VercelAIUIMessageChunk[] = [];
    this.maybeEmitStart(out);
    this.closeText(out);
    this.closeReasoning(out);
    out.push({ type: "finish" });
    return out;
  }

  private maybeEmitStart(out: VercelAIUIMessageChunk[]): void {
    if (this.startEmitted) return;
    this.startEmitted = true;
    out.push({ type: "start", messageId: `msg_${randomUUID()}` });
  }

  private openTextIfNeeded(out: VercelAIUIMessageChunk[]): void {
    if (this.currentTextId) return;
    this.currentTextId = `text_${randomUUID()}`;
    out.push({ type: "text-start", id: this.currentTextId });
  }

  private closeText(out: VercelAIUIMessageChunk[]): void {
    if (!this.currentTextId) return;
    out.push({ type: "text-end", id: this.currentTextId });
    this.currentTextId = null;
  }

  private openReasoningIfNeeded(out: VercelAIUIMessageChunk[]): void {
    if (this.currentReasoningId) return;
    this.currentReasoningId = `reasoning_${randomUUID()}`;
    out.push({ type: "reasoning-start", id: this.currentReasoningId });
  }

  private closeReasoning(out: VercelAIUIMessageChunk[]): void {
    if (!this.currentReasoningId) return;
    out.push({ type: "reasoning-end", id: this.currentReasoningId });
    this.currentReasoningId = null;
  }

  private handleStatus(
    status: string,
    error: string | undefined,
    out: VercelAIUIMessageChunk[],
  ): VercelAIUIMessageChunk[] {
    if (status === "error") {
      this.closeText(out);
      this.closeReasoning(out);
      out.push({ type: "error", errorText: error ?? "Unknown error" });
      // Pair `error` with `finish` so the client transitions out of
      // streaming state rather than waiting indefinitely for more chunks.
      if (!this.finalized) {
        this.finalized = true;
        out.push({ type: "finish" });
      }
      return out;
    }

    if (status === "complete") {
      // `complete` is the canonical happy-path terminator. Delegate to
      // `finalize()` so the close-text + close-reasoning + finish ordering
      // is shared with explicit caller-driven finalization.
      if (this.finalized) return out;
      this.finalized = true;
      this.closeText(out);
      this.closeReasoning(out);
      out.push({ type: "finish" });
      return out;
    }

    return out;
  }
}
