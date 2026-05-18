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
