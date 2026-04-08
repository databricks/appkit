import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  ResponseFunctionCallOutput,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "shared";

/**
 * Translates internal AgentEvent stream into Responses API SSE events.
 *
 * Stateful: one instance per streaming request. Tracks sequence numbers,
 * output indices, and message accumulation state.
 */
export class AgentEventTranslator {
  private seqNum = 0;
  private outputIndex = 0;
  private messageId: string | null = null;
  private messageText = "";

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
      case "status":
        return this.handleStatus(event.status, event.error);
    }
  }

  finalize(): ResponseStreamEvent[] {
    const events: ResponseStreamEvent[] = [];

    if (this.messageId) {
      const doneItem: ResponseOutputMessage = {
        type: "message",
        id: this.messageId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.messageText }],
      };
      events.push({
        type: "response.output_item.done",
        output_index: 0,
        item: doneItem,
        sequence_number: this.seqNum++,
      });
    }

    events.push({
      type: "response.completed",
      sequence_number: this.seqNum++,
      response: {},
    });

    return events;
  }

  private handleMessageDelta(content: string): ResponseStreamEvent[] {
    const events: ResponseStreamEvent[] = [];
    this.messageText += content;

    if (!this.messageId) {
      this.messageId = `msg_${randomUUID()}`;
      const item: ResponseOutputMessage = {
        type: "message",
        id: this.messageId,
        status: "in_progress",
        role: "assistant",
        content: [],
      };
      events.push({
        type: "response.output_item.added",
        output_index: 0,
        item,
        sequence_number: this.seqNum++,
      });
    }

    events.push({
      type: "response.output_text.delta",
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      delta: content,
      sequence_number: this.seqNum++,
    });

    return events;
  }

  private handleFullMessage(content: string): ResponseStreamEvent[] {
    if (!this.messageId) {
      this.messageId = `msg_${randomUUID()}`;
    }
    this.messageText = content;

    const item: ResponseOutputMessage = {
      type: "message",
      id: this.messageId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content }],
    };

    return [
      {
        type: "response.output_item.added",
        output_index: 0,
        item,
        sequence_number: this.seqNum++,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item,
        sequence_number: this.seqNum++,
      },
    ];
  }

  private handleToolCall(
    callId: string,
    name: string,
    args: unknown,
  ): ResponseStreamEvent[] {
    this.outputIndex++;
    const item: ResponseFunctionToolCall = {
      type: "function_call",
      id: `fc_${randomUUID()}`,
      call_id: callId,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    };

    return [
      {
        type: "response.output_item.added",
        output_index: this.outputIndex,
        item,
        sequence_number: this.seqNum++,
      },
      {
        type: "response.output_item.done",
        output_index: this.outputIndex,
        item,
        sequence_number: this.seqNum++,
      },
    ];
  }

  private handleToolResult(
    callId: string,
    result: unknown,
    error?: string,
  ): ResponseStreamEvent[] {
    this.outputIndex++;
    const output =
      error ?? (typeof result === "string" ? result : JSON.stringify(result));
    const item: ResponseFunctionCallOutput = {
      type: "function_call_output",
      id: `fc_output_${randomUUID()}`,
      call_id: callId,
      output,
    };

    return [
      {
        type: "response.output_item.added",
        output_index: this.outputIndex,
        item,
        sequence_number: this.seqNum++,
      },
      {
        type: "response.output_item.done",
        output_index: this.outputIndex,
        item,
        sequence_number: this.seqNum++,
      },
    ];
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
