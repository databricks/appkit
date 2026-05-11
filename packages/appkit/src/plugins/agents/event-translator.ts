import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  ResponseFunctionCallOutput,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "shared";

/**
 * Translates internal `AgentEvent` stream into Responses API SSE events.
 *
 * Stateful: one instance per streaming request. Tracks sequence numbers and
 * allocates `output_index` strictly monotonically — each emitted output
 * item (message, function call, function call output) claims the next
 * available index and, once claimed, never reuses an earlier one. This is a
 * Responses-API contract that OpenAI's own SDK parsers enforce.
 *
 * A message is opened lazily on the first `message_delta` or `message`
 * event. If a `tool_call` or `tool_result` arrives while a message is open
 * (common ReAct flow: partial text → tool call → more text), the open
 * message is closed (`response.output_item.done`) BEFORE the tool item is
 * added, so subsequent text resumes as a new message item at a strictly
 * later index.
 */
export class AgentEventTranslator {
  private seqNum = 0;
  private nextOutputIndex = 0;
  private currentMessage: {
    id: string;
    text: string;
    outputIndex: number;
  } | null = null;
  private finalized = false;

  translate(event: AgentEvent): ResponseStreamEvent[] {
    switch (event.type) {
      case "message_delta":
        return this.handleMessageDelta(event.content);
      case "message":
        return this.handleFullMessage(event.content);
      case "tool_call":
        return this.handleToolCall(event.callId, event.name, event.args);
      case "tool_result":
        return this.handleToolResult(event.callId, event.result, event.error);
      case "thinking":
        return [
          {
            type: "appkit.thinking",
            content: event.content,
            sequence_number: this.seqNum++,
          },
        ];
      case "metadata":
        return [
          {
            type: "appkit.metadata",
            data: event.data,
            sequence_number: this.seqNum++,
          },
        ];
      case "approval_pending":
        return [
          {
            type: "appkit.approval_pending",
            approval_id: event.approvalId,
            stream_id: event.streamId,
            tool_name: event.toolName,
            args: event.args,
            annotations: event.annotations,
            sequence_number: this.seqNum++,
          },
        ];
      case "status":
        return this.handleStatus(event.status, event.error);
    }
  }

  finalize(): ResponseStreamEvent[] {
    if (this.finalized) return [];
    this.finalized = true;

    const events: ResponseStreamEvent[] = [];
    const closeEvent = this.closeCurrentMessage();
    if (closeEvent) events.push(closeEvent);

    events.push({
      type: "response.completed",
      sequence_number: this.seqNum++,
      response: {},
    });

    return events;
  }

  private handleMessageDelta(content: string): ResponseStreamEvent[] {
    const events: ResponseStreamEvent[] = [];

    if (!this.currentMessage) {
      const id = `msg_${randomUUID()}`;
      const outputIndex = this.nextOutputIndex++;
      this.currentMessage = { id, text: content, outputIndex };
      const item: ResponseOutputMessage = {
        type: "message",
        id,
        status: "in_progress",
        role: "assistant",
        content: [],
      };
      events.push({
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
        sequence_number: this.seqNum++,
      });
    } else {
      this.currentMessage.text += content;
    }

    events.push({
      type: "response.output_text.delta",
      item_id: this.currentMessage.id,
      output_index: this.currentMessage.outputIndex,
      content_index: 0,
      delta: content,
      sequence_number: this.seqNum++,
    });

    return events;
  }

  private handleFullMessage(content: string): ResponseStreamEvent[] {
    const events: ResponseStreamEvent[] = [];

    if (!this.currentMessage) {
      // No prior deltas — open and immediately close.
      const id = `msg_${randomUUID()}`;
      const outputIndex = this.nextOutputIndex++;
      this.currentMessage = { id, text: content, outputIndex };
      const addedItem: ResponseOutputMessage = {
        type: "message",
        id,
        status: "in_progress",
        role: "assistant",
        content: [],
      };
      events.push({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: addedItem,
        sequence_number: this.seqNum++,
      });
    } else {
      // Deltas already opened the item; `message` overrides the accumulated
      // text (per adapter contract) and closes it.
      this.currentMessage.text = content;
    }

    const closeEvent = this.closeCurrentMessage();
    if (closeEvent) events.push(closeEvent);
    return events;
  }

  private handleToolCall(
    callId: string,
    name: string,
    args: unknown,
  ): ResponseStreamEvent[] {
    const events: ResponseStreamEvent[] = [];
    const closeEvent = this.closeCurrentMessage();
    if (closeEvent) events.push(closeEvent);

    const outputIndex = this.nextOutputIndex++;
    const item: ResponseFunctionToolCall = {
      type: "function_call",
      id: `fc_${randomUUID()}`,
      call_id: callId,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    };

    events.push(
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
        sequence_number: this.seqNum++,
      },
      {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
        sequence_number: this.seqNum++,
      },
    );
    return events;
  }

  private handleToolResult(
    callId: string,
    result: unknown,
    error?: string,
  ): ResponseStreamEvent[] {
    const events: ResponseStreamEvent[] = [];
    const closeEvent = this.closeCurrentMessage();
    if (closeEvent) events.push(closeEvent);

    const outputIndex = this.nextOutputIndex++;
    // Coalesce `undefined` → "" so the wire shape is always a string (the
    // Responses API contract). Non-string results are JSON-serialised.
    let output: string;
    if (error !== undefined) {
      output = error;
    } else if (typeof result === "string") {
      output = result;
    } else if (result === undefined) {
      output = "";
    } else {
      output = JSON.stringify(result);
    }
    const item: ResponseFunctionCallOutput = {
      type: "function_call_output",
      id: `fc_output_${randomUUID()}`,
      call_id: callId,
      output,
    };

    events.push(
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
        sequence_number: this.seqNum++,
      },
      {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
        sequence_number: this.seqNum++,
      },
    );
    return events;
  }

  /**
   * Emit an `response.output_item.done` for the currently-open message, if
   * any, and clear the state. Returns the event to the caller so it can be
   * pushed at the right moment in the sequence. Returns `null` when there
   * is no open message.
   */
  private closeCurrentMessage(): ResponseStreamEvent | null {
    if (!this.currentMessage) return null;
    const { id, text, outputIndex } = this.currentMessage;
    this.currentMessage = null;
    const doneItem: ResponseOutputMessage = {
      type: "message",
      id,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }],
    };
    return {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: doneItem,
      sequence_number: this.seqNum++,
    };
  }

  private handleStatus(status: string, error?: string): ResponseStreamEvent[] {
    if (status === "error") {
      return [
        {
          type: "error",
          error: error ?? "Unknown error",
          sequence_number: this.seqNum++,
        },
        {
          type: "response.failed",
          sequence_number: this.seqNum++,
        },
      ];
    }

    if (status === "complete") {
      return this.finalize();
    }

    return [];
  }
}
