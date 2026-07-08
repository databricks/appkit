import {
  DefaultChatTransport,
  type HttpChatTransportInitOptions,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type {
  ResponseFunctionCallOutput,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "shared";
import { generateId } from "./utils";

/**
 * `useChat`-compatible transport for AppKit's agents plugin. Translates
 * the Responses-API SSE wire format into the Vercel AI SDK's
 * `UIMessageChunk` protocol, and shapes outgoing requests as
 * `{ message, threadId, ... }`.
 */
export interface ResponsesApiTransportOptions<T extends UIMessage>
  extends Omit<HttpChatTransportInitOptions<T>, "prepareSendMessagesRequest"> {
  /** Fires synchronously for every translated chunk; unaffected by render throttling. */
  onStreamPart?: (chunk: UIMessageChunk) => void;
  /** Returns the server-allocated thread id to echo on subsequent requests. */
  getThreadId?: () => string | undefined;
  /** Persists the thread id snooped from the first `appkit.metadata` event. */
  onThreadId?: (id: string) => void;
}

/** Reserved body keys the transport derives itself; consumer overrides ignored. */
const RESERVED_BODY_KEYS = new Set(["message", "threadId"]);

export class ResponsesApiTransport<
  T extends UIMessage,
> extends DefaultChatTransport<T> {
  private onStreamPartTap: ((chunk: UIMessageChunk) => void) | undefined;
  private onThreadId: ((id: string) => void) | undefined;

  constructor(options: ResponsesApiTransportOptions<T>) {
    const { onStreamPart, getThreadId, onThreadId, ...rest } = options;
    super({
      ...rest,
      prepareSendMessagesRequest: ({ messages, body }) => {
        const consumer = (body ?? {}) as Record<string, unknown>;
        const consumerExtras: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(consumer)) {
          if (!RESERVED_BODY_KEYS.has(key)) consumerExtras[key] = value;
        }
        const threadId = getThreadId?.();
        return {
          body: {
            message: extractLastUserText(messages),
            ...(threadId !== undefined && { threadId }),
            ...consumerExtras,
          },
        };
      },
    });
    this.onStreamPartTap = onStreamPart;
    this.onThreadId = onThreadId;
  }

  protected processResponseStream(
    stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  ): ReadableStream<UIMessageChunk> {
    // Cast: `TextDecoderStream` is typed as `BufferSource`; Uint8Array satisfies it at runtime.
    return (stream as unknown as ReadableStream<BufferSource>)
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(sseEventLineParser())
      .pipeThrough(this.captureThreadIdTap())
      .pipeThrough(responsesApiToUiChunks(this.onStreamPartTap));
  }

  /** Forwards the thread id from `appkit.metadata` events to `onThreadId`. */
  private captureThreadIdTap(): TransformStream<
    ResponseStreamEvent,
    ResponseStreamEvent
  > {
    const onThreadId = this.onThreadId;
    return new TransformStream({
      transform(event, controller) {
        if (event.type === "appkit.metadata") {
          const tid = (event.data as { threadId?: unknown } | undefined)
            ?.threadId;
          if (typeof tid === "string" && tid.length > 0) {
            onThreadId?.(tid);
          }
        }
        controller.enqueue(event);
      },
    });
  }
}

function extractLastUserText<T extends UIMessage>(messages: T[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return "";
  let text = "";
  let droppedNonText = false;
  for (const part of last.parts as Array<{ type: string; text?: unknown }>) {
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
    } else {
      droppedNonText = true;
    }
  }
  if (droppedNonText) {
    // Agents plugin only accepts plain text; subclass to carry attachments.
    console.warn(
      "[ResponsesApiTransport] Dropping non-text parts from user message — agents plugin only accepts plain text.",
    );
  }
  return text;
}

/**
 * Splits an SSE text stream into `ResponseStreamEvent`s. Falls back to
 * the `event:` header when the JSON body lacks a `type` field (e.g.
 * `SSEWriter.writeError` payloads).
 */
function sseEventLineParser(): TransformStream<string, ResponseStreamEvent> {
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      // Normalize CRLF → LF so the `\n\n` boundary split works behind
      // intermediaries that re-emit SSE frames with CRLF line endings.
      buffer += chunk.replace(/\r\n/g, "\n");
      let separatorIdx: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE buffer drain pattern
      while ((separatorIdx = buffer.indexOf("\n\n")) !== -1) {
        const message = buffer.slice(0, separatorIdx);
        buffer = buffer.slice(separatorIdx + 2);
        let eventName: string | undefined;
        const dataLines: string[] = [];
        for (const line of message.split("\n")) {
          if (line.length === 0 || line.startsWith(":")) continue;
          if (line.startsWith("event:")) {
            eventName = line.slice(6).replace(/^ /, "");
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length === 0) continue;
        const data = dataLines.join("\n");
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof parsed.type !== "string" && eventName) {
          parsed.type = eventName;
        }
        controller.enqueue(parsed as unknown as ResponseStreamEvent);
      }
    },
  });
}

/**
 * Stateful translator: `ResponseStreamEvent` → `UIMessageChunk`.
 *
 * Text spans mirror server message item ids 1:1. `appkit.thinking` has
 * no wrapping events, so the reasoning span is opened lazily and closed
 * on the next non-thinking event. `appkit.approval_pending` rides as a
 * `data-*` chunk and does not close any open spans (the agent loop may
 * resume the same span after the user decides).
 */
function responsesApiToUiChunks(
  tap: ((chunk: UIMessageChunk) => void) | undefined,
): TransformStream<ResponseStreamEvent, UIMessageChunk> {
  let startEmitted = false;
  let currentReasoningId: string | null = null;
  let finalized = false;

  function emit(
    controller: TransformStreamDefaultController<UIMessageChunk>,
    chunk: UIMessageChunk,
  ): void {
    tap?.(chunk);
    controller.enqueue(chunk);
  }

  function emitStart(
    controller: TransformStreamDefaultController<UIMessageChunk>,
  ): void {
    if (startEmitted) return;
    startEmitted = true;
    emit(controller, { type: "start", messageId: `msg_${generateId()}` });
  }

  function closeReasoning(
    controller: TransformStreamDefaultController<UIMessageChunk>,
  ): void {
    if (!currentReasoningId) return;
    emit(controller, { type: "reasoning-end", id: currentReasoningId });
    currentReasoningId = null;
  }

  function finish(
    controller: TransformStreamDefaultController<UIMessageChunk>,
  ): void {
    if (finalized) return;
    finalized = true;
    closeReasoning(controller);
    emit(controller, { type: "finish" });
  }

  return new TransformStream({
    transform(event, controller) {
      emitStart(controller);
      switch (event.type) {
        case "response.output_item.added": {
          const item = event.item;
          closeReasoning(controller);
          if (item.type === "message") {
            const msg = item as ResponseOutputMessage;
            emit(controller, { type: "text-start", id: msg.id });
          } else if (item.type === "function_call") {
            const fc = item as ResponseFunctionToolCall;
            let input: unknown;
            try {
              input = JSON.parse(fc.arguments);
            } catch {
              input = fc.arguments;
            }
            emit(controller, {
              type: "tool-input-available",
              toolCallId: fc.call_id,
              toolName: fc.name,
              input,
            });
          } else if (item.type === "function_call_output") {
            const fco = item as ResponseFunctionCallOutput;
            emit(controller, {
              type: "tool-output-available",
              toolCallId: fco.call_id,
              output: fco.output,
            });
          }
          return;
        }
        case "response.output_item.done": {
          const item = event.item;
          if (item.type === "message") {
            emit(controller, { type: "text-end", id: item.id });
          }
          // function_call / function_call_output `done` events have no
          // client counterpart; they're already emitted on `added`.
          return;
        }
        case "response.output_text.delta":
          emit(controller, {
            type: "text-delta",
            id: event.item_id,
            delta: event.delta,
          });
          return;
        case "appkit.thinking":
          if (!currentReasoningId) {
            currentReasoningId = `reasoning_${generateId()}`;
            emit(controller, {
              type: "reasoning-start",
              id: currentReasoningId,
            });
          }
          emit(controller, {
            type: "reasoning-delta",
            id: currentReasoningId,
            delta: event.content,
          });
          return;
        case "appkit.metadata":
          closeReasoning(controller);
          emit(controller, {
            type: "message-metadata",
            messageMetadata: event.data,
          });
          return;
        case "appkit.approval_pending":
          emit(controller, {
            type: "data-approval-pending",
            id: event.approval_id,
            data: {
              approvalId: event.approval_id,
              streamId: event.stream_id,
              toolName: event.tool_name,
              args: event.args,
              annotations: event.annotations,
            },
          } as UIMessageChunk);
          return;
        case "error":
          if (finalized) return;
          closeReasoning(controller);
          emit(controller, { type: "error", errorText: event.error });
          finalized = true;
          emit(controller, { type: "finish" });
          return;
        case "response.failed":
          finish(controller);
          return;
        case "response.completed":
          finish(controller);
          return;
      }
    },
    flush(controller) {
      // Ensure the SDK leaves the streaming state if the terminal event was lost.
      finish(controller);
    },
  });
}
