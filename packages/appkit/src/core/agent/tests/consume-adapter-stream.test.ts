import type { AgentEvent } from "shared";
import { describe, expect, test } from "vitest";
import { consumeAdapterStream } from "../consume-adapter-stream";

async function* streamOf(
  events: AgentEvent[],
): AsyncGenerator<AgentEvent, void, unknown> {
  for (const event of events) {
    yield event;
  }
}

describe("consumeAdapterStream", () => {
  test("concatenates message_delta events into the final text", async () => {
    const text = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "Hello " },
        { type: "message_delta", content: "world" },
      ]),
    );
    expect(text).toBe("Hello world");
  });

  test("a `message` event replaces whatever deltas arrived so far", async () => {
    const text = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "partial" },
        { type: "message", content: "final answer" },
      ]),
    );
    expect(text).toBe("final answer");
  });

  test("multi-round ReAct: returns the terminal message, not the drafts", async () => {
    // OpenAI-compatible Claude emits a full draft answer alongside its tool
    // call on every round. Only the final round's message is the answer.
    const text = await consumeAdapterStream(
      streamOf([
        // Round 1: draft + tool call
        { type: "message_delta", content: "The answer is 42." },
        { type: "tool_call", callId: "c1", name: "lookup", args: {} },
        { type: "tool_result", callId: "c1", result: "ok" },
        // Round 2: another draft + tool call
        { type: "message_delta", content: "The answer is 42." },
        { type: "tool_call", callId: "c2", name: "verify", args: {} },
        { type: "tool_result", callId: "c2", result: "ok" },
        // Terminal round: the real answer, streamed live
        { type: "message_delta", content: "The answer " },
        { type: "message_delta", content: "is 42." },
      ]),
    );
    expect(text).toBe("The answer is 42.");
  });

  test("maxSteps exhausted mid-tool-calling: returns the last draft", async () => {
    // Stream ends right after a tool_call following a draft — no terminal
    // message was produced, so fall back to the last closed message.
    const text = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "Working on it…" },
        { type: "tool_call", callId: "c1", name: "lookup", args: {} },
      ]),
    );
    expect(text).toBe("Working on it…");
  });

  test("LangChain single `message` after tool calls still replaces", async () => {
    const text = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "draft" },
        { type: "tool_call", callId: "c1", name: "lookup", args: {} },
        { type: "tool_result", callId: "c1", result: "ok" },
        { type: "message", content: "final answer" },
      ]),
    );
    expect(text).toBe("final answer");
  });

  test("mixed: deltas then a tool_call then a fresh terminal delta", async () => {
    const text = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "thinking " },
        { type: "message_delta", content: "out loud" },
        { type: "tool_call", callId: "c1", name: "lookup", args: {} },
        { type: "tool_result", callId: "c1", result: "ok" },
        { type: "message_delta", content: "done" },
      ]),
    );
    expect(text).toBe("done");
  });

  test("invokes onEvent once per event, in order, with the raw event", async () => {
    const seen: AgentEvent[] = [];
    await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "a" },
        { type: "thinking", content: "…" },
        { type: "message_delta", content: "b" },
      ]),
      { onEvent: (ev) => seen.push(ev) },
    );
    expect(seen.map((e) => e.type)).toEqual([
      "message_delta",
      "thinking",
      "message_delta",
    ]);
  });

  test("stops iterating once the signal aborts", async () => {
    const controller = new AbortController();
    const emitted: string[] = [];
    await consumeAdapterStream(
      (async function* () {
        yield { type: "message_delta", content: "first" } as AgentEvent;
        controller.abort();
        yield { type: "message_delta", content: "second" } as AgentEvent;
      })(),
      {
        signal: controller.signal,
        onEvent: (ev) => {
          if (ev.type === "message_delta") emitted.push(ev.content);
        },
      },
    );
    expect(emitted).toEqual(["first"]);
  });

  test("returns an empty string for a stream with no content events", async () => {
    const text = await consumeAdapterStream(
      streamOf([{ type: "thinking", content: "…" }]),
    );
    expect(text).toBe("");
  });

  test("works without a signal (standalone runAgent path)", async () => {
    const text = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "x" },
        { type: "message_delta", content: "y" },
      ]),
    );
    expect(text).toBe("xy");
  });
});
