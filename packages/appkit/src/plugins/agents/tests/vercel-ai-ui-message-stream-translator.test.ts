import { describe, expect, test } from "vitest";
import {
  type VercelAIUIMessageChunk,
  VercelAIUIMessageStreamTranslator,
} from "../vercel-ai-ui-message-stream-translator";

/**
 * Reduces a translator output stream so assertions don't have to encode
 * the random `start.messageId` and `text-start.id` UUIDs. Replaces every
 * occurrence of the same id with a deterministic placeholder per kind so
 * we can still assert "deltas reference the same span as start/end".
 */
function normalize(chunks: VercelAIUIMessageChunk[]): VercelAIUIMessageChunk[] {
  const seen = new Map<string, string>();
  const counts: Record<string, number> = {};
  const slot = (kind: string, id: string): string => {
    const key = `${kind}:${id}`;
    if (!seen.has(key)) {
      counts[kind] = (counts[kind] ?? 0) + 1;
      seen.set(key, `${kind}_${counts[kind]}`);
    }
    return seen.get(key) as string;
  };
  return chunks.map((c) => {
    switch (c.type) {
      case "start":
        return { ...c, messageId: c.messageId ? "msg_1" : c.messageId };
      case "text-start":
      case "text-delta":
      case "text-end":
        return { ...c, id: slot("text", c.id) };
      case "reasoning-start":
      case "reasoning-delta":
      case "reasoning-end":
        return { ...c, id: slot("reasoning", c.id) };
      default:
        return c;
    }
  });
}

describe("VercelAIUIMessageStreamTranslator", () => {
  test("emits exactly one start chunk on the first event", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    const a = t.translate({ type: "message_delta", content: "hello" });
    const b = t.translate({ type: "message_delta", content: " world" });
    const startChunks = [...a, ...b].filter((c) => c.type === "start");
    expect(startChunks).toHaveLength(1);
    expect(startChunks[0]).toMatchObject({ type: "start" });
    expect((startChunks[0] as { messageId?: string }).messageId).toMatch(
      /^msg_/,
    );
  });

  test("opens text span lazily and reuses the same id across deltas", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    const out = normalize([
      ...t.translate({ type: "message_delta", content: "he" }),
      ...t.translate({ type: "message_delta", content: "llo" }),
      ...t.finalize(),
    ]);

    expect(out).toEqual([
      { type: "start", messageId: "msg_1" },
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "he" },
      { type: "text-delta", id: "text_1", delta: "llo" },
      { type: "text-end", id: "text_1" },
      { type: "finish" },
    ]);
  });

  test("closes open text-span before a tool-call", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    const out = normalize([
      ...t.translate({ type: "message_delta", content: "thinking..." }),
      ...t.translate({
        type: "tool_call",
        callId: "call_1",
        name: "search",
        args: { q: "x" },
      }),
      ...t.translate({
        type: "tool_result",
        callId: "call_1",
        result: { hits: 3 },
      }),
      ...t.translate({ type: "message_delta", content: "done" }),
      ...t.finalize(),
    ]);

    expect(out).toEqual([
      { type: "start", messageId: "msg_1" },
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "thinking..." },
      { type: "text-end", id: "text_1" },
      {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "search",
        input: { q: "x" },
      },
      {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: { hits: 3 },
      },
      { type: "text-start", id: "text_2" },
      { type: "text-delta", id: "text_2", delta: "done" },
      { type: "text-end", id: "text_2" },
      { type: "finish" },
    ]);
  });

  test("emits tool-output-error when tool_result carries an error", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    const out = normalize([
      ...t.translate({
        type: "tool_call",
        callId: "call_1",
        name: "search",
        args: {},
      }),
      ...t.translate({
        type: "tool_result",
        callId: "call_1",
        result: undefined,
        error: "Tool blew up",
      }),
      ...t.finalize(),
    ]);

    expect(out).toContainEqual({
      type: "tool-output-error",
      toolCallId: "call_1",
      errorText: "Tool blew up",
    });
    expect(out.some((c) => c.type === "tool-output-available")).toBe(false);
  });

  test("forwards approval_pending as a data-approval-pending part keyed by approvalId", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    t.translate({ type: "message_delta", content: "pre" });
    const chunks = t.translate({
      type: "approval_pending",
      approvalId: "appr_1",
      streamId: "stream_1",
      toolName: "delete_view",
      args: { id: 42 },
      annotations: { effect: "destructive" },
    });

    const dataPart = chunks.find(
      (c) => c.type === "data-approval-pending",
    ) as Extract<VercelAIUIMessageChunk, { type: `data-${string}` }>;

    expect(dataPart).toBeDefined();
    expect(dataPart.id).toBe("appr_1");
    expect(dataPart.data).toEqual({
      approvalId: "appr_1",
      streamId: "stream_1",
      toolName: "delete_view",
      args: { id: 42 },
      annotations: { effect: "destructive" },
    });
    // Approval is concurrent with an open text span — must NOT close it.
    expect(chunks.some((c) => c.type === "text-end")).toBe(false);
  });

  test("opens reasoning lazily, closes before a text-delta", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    const out = normalize([
      ...t.translate({ type: "thinking", content: "let me see..." }),
      ...t.translate({ type: "message_delta", content: "result" }),
      ...t.finalize(),
    ]);

    expect(out).toEqual([
      { type: "start", messageId: "msg_1" },
      { type: "reasoning-start", id: "reasoning_1" },
      {
        type: "reasoning-delta",
        id: "reasoning_1",
        delta: "let me see...",
      },
      { type: "reasoning-end", id: "reasoning_1" },
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "result" },
      { type: "text-end", id: "text_1" },
      { type: "finish" },
    ]);
  });

  test("metadata events become message-metadata chunks", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    const out = t.translate({
      type: "metadata",
      data: { threadId: "thread_42" },
    });
    expect(out).toContainEqual({
      type: "message-metadata",
      messageMetadata: { threadId: "thread_42" },
    });
  });

  test("status: error closes spans and emits error+finish", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    const out = normalize([
      ...t.translate({ type: "message_delta", content: "halfway" }),
      ...t.translate({
        type: "status",
        status: "error",
        error: "boom",
      }),
    ]);

    expect(out).toEqual([
      { type: "start", messageId: "msg_1" },
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "halfway" },
      { type: "text-end", id: "text_1" },
      { type: "error", errorText: "boom" },
      { type: "finish" },
    ]);
  });

  test("status: complete is treated as a terminator equivalent to finalize", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    const out = normalize([
      ...t.translate({ type: "message_delta", content: "ok" }),
      ...t.translate({ type: "status", status: "complete" }),
      ...t.finalize(),
    ]);

    expect(out.filter((c) => c.type === "finish")).toHaveLength(1);
    expect(out.filter((c) => c.type === "text-end")).toHaveLength(1);
  });

  test("finalize is idempotent", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    t.translate({ type: "message_delta", content: "hi" });
    const first = t.finalize();
    const second = t.finalize();

    expect(first.filter((c) => c.type === "finish")).toHaveLength(1);
    expect(second).toEqual([]);
  });

  test("status: running is silently dropped (no chunks)", () => {
    const t = new VercelAIUIMessageStreamTranslator();
    const out = t.translate({ type: "status", status: "running" });
    // start is emitted because every translate() call may emit start; but
    // no other content chunks should appear.
    expect(out.filter((c) => c.type !== "start")).toEqual([]);
  });
});
