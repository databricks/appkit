import type { UIMessage, UIMessageChunk } from "ai";
import type { ResponseStreamEvent } from "shared";
import { describe, expect, test } from "vitest";
import { ResponsesApiTransport } from "./responses-api-transport";

// Exposes the protected `processResponseStream` for direct testing.
class TestableTransport<T extends UIMessage> extends ResponsesApiTransport<T> {
  public process(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    return this.processResponseStream(stream);
  }
}

function encodeSseStream(
  events: ResponseStreamEvent[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = events
    .map((e, i) => `id: ${i}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

async function translate(
  events: ResponseStreamEvent[],
  onStreamPart?: (chunk: UIMessageChunk) => void,
): Promise<UIMessageChunk[]> {
  const transport = new TestableTransport<UIMessage>({
    api: "/test",
    onStreamPart,
  });
  const out = transport.process(encodeSseStream(events));
  const reader = out.getReader();
  const chunks: UIMessageChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

// Replaces random ids with deterministic placeholders for easier assertions.
// Server-allocated ids are preserved.
function normalize(chunks: UIMessageChunk[]): UIMessageChunk[] {
  let reasoningCounter = 0;
  const reasoningMap = new Map<string, string>();
  const slot = (id: string): string => {
    if (!reasoningMap.has(id)) {
      reasoningCounter++;
      reasoningMap.set(id, `reasoning_${reasoningCounter}`);
    }
    return reasoningMap.get(id) as string;
  };
  return chunks.map((c) => {
    if (c.type === "start") {
      return { ...c, messageId: c.messageId ? "msg_start" : c.messageId };
    }
    if (
      c.type === "reasoning-start" ||
      c.type === "reasoning-delta" ||
      c.type === "reasoning-end"
    ) {
      return { ...c, id: slot(c.id) };
    }
    return c;
  });
}

const SEQ = (() => {
  let n = 0;
  return () => n++;
})();

const messageItem = (id: string) => ({
  type: "message" as const,
  id,
  status: "in_progress" as const,
  role: "assistant" as const,
  content: [],
});

const messageItemDone = (id: string, text: string) => ({
  type: "message" as const,
  id,
  status: "completed" as const,
  role: "assistant" as const,
  content: [{ type: "output_text" as const, text }],
});

describe("ResponsesApiTransport", () => {
  test("emits exactly one start chunk on the first event", async () => {
    const out = await translate([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: messageItem("msg_a"),
        sequence_number: SEQ(),
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_a",
        output_index: 0,
        content_index: 0,
        delta: "hello",
        sequence_number: SEQ(),
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_a",
        output_index: 0,
        content_index: 0,
        delta: " world",
        sequence_number: SEQ(),
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: messageItemDone("msg_a", "hello world"),
        sequence_number: SEQ(),
      },
      { type: "response.completed", sequence_number: SEQ(), response: {} },
    ]);
    const startChunks = out.filter((c) => c.type === "start");
    expect(startChunks).toHaveLength(1);
    expect(startChunks[0]).toMatchObject({ type: "start" });
    expect((startChunks[0] as { messageId?: string }).messageId).toMatch(
      /^msg_/,
    );
  });

  test("text spans mirror server message item ids 1:1", async () => {
    const out = normalize(
      await translate([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: messageItem("msg_a"),
          sequence_number: SEQ(),
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_a",
          output_index: 0,
          content_index: 0,
          delta: "he",
          sequence_number: SEQ(),
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_a",
          output_index: 0,
          content_index: 0,
          delta: "llo",
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: messageItemDone("msg_a", "hello"),
          sequence_number: SEQ(),
        },
        { type: "response.completed", sequence_number: SEQ(), response: {} },
      ]),
    );

    expect(out).toEqual([
      { type: "start", messageId: "msg_start" },
      { type: "text-start", id: "msg_a" },
      { type: "text-delta", id: "msg_a", delta: "he" },
      { type: "text-delta", id: "msg_a", delta: "llo" },
      { type: "text-end", id: "msg_a" },
      { type: "finish" },
    ]);
  });

  test("interleaved text → tool → text uses fresh message ids per text run", async () => {
    const out = normalize(
      await translate([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: messageItem("msg_1"),
          sequence_number: SEQ(),
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "thinking...",
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: messageItemDone("msg_1", "thinking..."),
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "search",
            arguments: '{"q":"x"}',
          },
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "search",
            arguments: '{"q":"x"}',
          },
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.added",
          output_index: 2,
          item: {
            type: "function_call_output",
            id: "fc_out_1",
            call_id: "call_1",
            output: '{"hits":3}',
          },
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.done",
          output_index: 2,
          item: {
            type: "function_call_output",
            id: "fc_out_1",
            call_id: "call_1",
            output: '{"hits":3}',
          },
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.added",
          output_index: 3,
          item: messageItem("msg_2"),
          sequence_number: SEQ(),
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_2",
          output_index: 3,
          content_index: 0,
          delta: "done",
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.done",
          output_index: 3,
          item: messageItemDone("msg_2", "done"),
          sequence_number: SEQ(),
        },
        { type: "response.completed", sequence_number: SEQ(), response: {} },
      ]),
    );

    expect(out).toEqual([
      { type: "start", messageId: "msg_start" },
      { type: "text-start", id: "msg_1" },
      { type: "text-delta", id: "msg_1", delta: "thinking..." },
      { type: "text-end", id: "msg_1" },
      {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "search",
        input: { q: "x" },
      },
      {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: '{"hits":3}',
      },
      { type: "text-start", id: "msg_2" },
      { type: "text-delta", id: "msg_2", delta: "done" },
      { type: "text-end", id: "msg_2" },
      { type: "finish" },
    ]);
  });

  test("tool-input-available falls back to raw arguments when JSON.parse fails", async () => {
    const out = await translate([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "search",
          arguments: "not-json",
        },
        sequence_number: SEQ(),
      },
      { type: "response.completed", sequence_number: SEQ(), response: {} },
    ]);
    expect(out).toContainEqual({
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName: "search",
      input: "not-json",
    });
  });

  test("approval_pending becomes a data-approval-pending part keyed by approvalId without closing open spans", async () => {
    const out = await translate([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: messageItem("msg_a"),
        sequence_number: SEQ(),
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_a",
        output_index: 0,
        content_index: 0,
        delta: "pre",
        sequence_number: SEQ(),
      },
      {
        type: "appkit.approval_pending",
        approval_id: "appr_1",
        stream_id: "stream_1",
        tool_name: "delete_view",
        args: { id: 42 },
        annotations: { effect: "destructive" },
        sequence_number: SEQ(),
      },
    ]);
    const dataPart = out.find((c) => c.type === "data-approval-pending") as
      | { id?: string; data?: unknown; type: string }
      | undefined;
    expect(dataPart).toBeDefined();
    expect(dataPart?.id).toBe("appr_1");
    expect(dataPart?.data).toEqual({
      approvalId: "appr_1",
      streamId: "stream_1",
      toolName: "delete_view",
      args: { id: 42 },
      annotations: { effect: "destructive" },
    });
    // Open text span must stay open while approval is pending.
    const textEndBeforeApproval = out
      .slice(
        0,
        out.findIndex((c) => c.type === "data-approval-pending"),
      )
      .some((c) => c.type === "text-end");
    expect(textEndBeforeApproval).toBe(false);
  });

  test("appkit.thinking opens a reasoning span and closes it before any non-thinking event", async () => {
    const out = normalize(
      await translate([
        {
          type: "appkit.thinking",
          content: "let me see...",
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: messageItem("msg_a"),
          sequence_number: SEQ(),
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_a",
          output_index: 0,
          content_index: 0,
          delta: "result",
          sequence_number: SEQ(),
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: messageItemDone("msg_a", "result"),
          sequence_number: SEQ(),
        },
        { type: "response.completed", sequence_number: SEQ(), response: {} },
      ]),
    );

    expect(out).toEqual([
      { type: "start", messageId: "msg_start" },
      { type: "reasoning-start", id: "reasoning_1" },
      {
        type: "reasoning-delta",
        id: "reasoning_1",
        delta: "let me see...",
      },
      { type: "reasoning-end", id: "reasoning_1" },
      { type: "text-start", id: "msg_a" },
      { type: "text-delta", id: "msg_a", delta: "result" },
      { type: "text-end", id: "msg_a" },
      { type: "finish" },
    ]);
  });

  test("appkit.metadata becomes a message-metadata chunk", async () => {
    const out = await translate([
      {
        type: "appkit.metadata",
        data: { threadId: "thread_42" },
        sequence_number: SEQ(),
      },
      { type: "response.completed", sequence_number: SEQ(), response: {} },
    ]);
    expect(out).toContainEqual({
      type: "message-metadata",
      messageMetadata: { threadId: "thread_42" },
    });
  });

  test("error event closes spans, emits error + finish (idempotent)", async () => {
    const out = normalize(
      await translate([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: messageItem("msg_a"),
          sequence_number: SEQ(),
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_a",
          output_index: 0,
          content_index: 0,
          delta: "halfway",
          sequence_number: SEQ(),
        },
        {
          type: "appkit.thinking",
          content: "wait",
          sequence_number: SEQ(),
        },
        { type: "error", error: "boom", sequence_number: SEQ() },
        // A stray response.failed after error must not duplicate finish.
        { type: "response.failed", sequence_number: SEQ() },
      ]),
    );
    expect(out.filter((c) => c.type === "finish")).toHaveLength(1);
    expect(out).toContainEqual({ type: "error", errorText: "boom" });
    expect(out.filter((c) => c.type === "reasoning-end")).toHaveLength(1);
  });

  test("synthesises a finish chunk when the stream ends without a terminator", async () => {
    const out = await translate([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: messageItem("msg_a"),
        sequence_number: SEQ(),
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_a",
        output_index: 0,
        content_index: 0,
        delta: "incomplete",
        sequence_number: SEQ(),
      },
      // No terminator: stream ends mid-message.
    ]);
    expect(out[out.length - 1]).toEqual({ type: "finish" });
  });

  test("onStreamPart tap fires for every emitted chunk", async () => {
    const tapped: UIMessageChunk[] = [];
    const events: ResponseStreamEvent[] = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: messageItem("msg_a"),
        sequence_number: SEQ(),
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_a",
        output_index: 0,
        content_index: 0,
        delta: "hi",
        sequence_number: SEQ(),
      },
      { type: "response.completed", sequence_number: SEQ(), response: {} },
    ];
    const out = await translate(events, (chunk) => {
      tapped.push(chunk);
    });
    expect(tapped).toEqual(out);
  });

  test("routes SSEWriter-style error events (no `type` field, only event header) into an error chunk", async () => {
    // SSEWriter.writeError emits `event: error` + `{ error, code }` body
    // without a `type` field.
    const encoder = new TextEncoder();
    const body = `id: 1\nevent: error\ndata: ${JSON.stringify({
      error: "stream evicted",
      code: "STREAM_EVICTED",
    })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    const transport = new TestableTransport<UIMessage>({ api: "/test" });
    const out = transport.process(stream);
    const reader = out.getReader();
    const chunks: UIMessageChunk[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks.map((c) => c.type)).toEqual(["start", "error", "finish"]);
    expect(chunks).toContainEqual({
      type: "error",
      errorText: "stream evicted",
    });
  });

  test("ignores SSE comment lines (heartbeats) and unknown event types", async () => {
    const encoder = new TextEncoder();
    const body =
      `: heartbeat\n\n` +
      `id: 1\nevent: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        sequence_number: 0,
        response: {},
      })}\n\n` +
      `: heartbeat\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    const transport = new TestableTransport<UIMessage>({ api: "/test" });
    const out = transport.process(stream);
    const reader = out.getReader();
    const chunks: UIMessageChunk[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
  });
});
