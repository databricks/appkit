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
    const result = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "Hello " },
        { type: "message_delta", content: "world" },
      ]),
    );
    expect(result.text).toBe("Hello world");
  });

  test("a `message` event replaces whatever deltas arrived so far", async () => {
    const result = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "partial" },
        { type: "message", content: "final answer" },
      ]),
    );
    expect(result.text).toBe("final answer");
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
    const result = await consumeAdapterStream(
      streamOf([{ type: "thinking", content: "…" }]),
    );
    expect(result.text).toBe("");
  });

  test("works without a signal (standalone runAgent path)", async () => {
    const result = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "x" },
        { type: "message_delta", content: "y" },
      ]),
    );
    expect(result.text).toBe("xy");
  });

  test("retains lifecycle usage and the last remote trace without adding user-visible text", async () => {
    const result = await consumeAdapterStream(
      streamOf([
        { type: "message_delta", content: "answer" },
        {
          type: "model_start",
          stepId: "step-1",
          model: "model-a",
          provider: "databricks",
          input: { prompt: "hello" },
          startedAt: 100,
        },
        {
          type: "model_end",
          stepId: "step-1",
          model: "model-a",
          provider: "databricks",
          output: { text: "first" },
          usage: {
            inputTokens: 10,
            outputTokens: 3,
            totalTokens: 13,
            costUsd: 0.02,
            costAvailable: true,
          },
          streamDurationMs: 20,
          endedAt: 120,
        },
        {
          type: "remote_trace",
          traceId: "abcdef0123456789abcdef0123456789",
          spanId: "0123456789abcdef",
          source: "model-serving",
          relation: "linked",
        },
        {
          type: "model_end",
          stepId: "step-2",
          model: "model-b",
          provider: "databricks",
          output: { text: "second" },
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            totalTokens: 6,
            costAvailable: false,
          },
          streamDurationMs: 30,
          endedAt: 150,
        },
      ]),
    );

    expect(result).toEqual({
      text: "answer",
      usage: {
        inputTokens: 14,
        outputTokens: 5,
        totalTokens: 19,
        costAvailable: false,
      },
      remoteTrace: {
        type: "remote_trace",
        traceId: "abcdef0123456789abcdef0123456789",
        spanId: "0123456789abcdef",
        source: "model-serving",
        relation: "linked",
      },
    });
  });
});
