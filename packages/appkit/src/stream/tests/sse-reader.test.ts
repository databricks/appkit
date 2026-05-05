import { describe, expect, test } from "vitest";
import { readSseEvents, type SseEvent } from "../sse-reader";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(
  gen: AsyncGenerator<SseEvent, void, unknown>,
): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("readSseEvents", () => {
  test("parses a single named event with JSON data", async () => {
    const events = await collect(
      readSseEvents(
        streamOf(['event: response.completed\ndata: {"ok":true}\n\n']),
      ),
    );
    expect(events).toEqual([
      { event: "response.completed", data: '{"ok":true}', id: undefined },
    ]);
  });

  test("pairs event: and data: across chunk boundaries", async () => {
    const events = await collect(
      readSseEvents(
        streamOf([
          "event: response.output_text.delta\n",
          'data: {"delta":"split"}\n\n',
        ]),
      ),
    );
    expect(events).toEqual([
      {
        event: "response.output_text.delta",
        data: '{"delta":"split"}',
        id: undefined,
      },
    ]);
  });

  test("ignores blank lines, comment lines, and unknown fields", async () => {
    const events = await collect(
      readSseEvents(
        streamOf([": heartbeat\n\nretry: 1000\nevent: ping\ndata: hi\n\n"]),
      ),
    );
    expect(events).toEqual([{ event: "ping", data: "hi", id: undefined }]);
  });

  test("captures id: when present", async () => {
    const events = await collect(
      readSseEvents(streamOf(["id: abc-123\nevent: ping\ndata: hi\n\n"])),
    );
    expect(events).toEqual([{ event: "ping", data: "hi", id: "abc-123" }]);
  });

  test("falls back to empty event name when only data: is present", async () => {
    const events = await collect(readSseEvents(streamOf(["data: 1\n\n"])));
    expect(events).toEqual([{ event: "", data: "1", id: undefined }]);
  });

  test("joins multi-line data: payloads with \\n", async () => {
    const events = await collect(
      readSseEvents(streamOf(["data: line1\ndata: line2\n\n"])),
    );
    expect(events).toEqual([
      { event: "", data: "line1\nline2", id: undefined },
    ]);
  });

  test("normalises CRLF line endings", async () => {
    const events = await collect(
      readSseEvents(streamOf(["event: x\r\ndata: y\r\n\r\n"])),
    );
    expect(events).toEqual([{ event: "x", data: "y", id: undefined }]);
  });

  test("emits a trailing event when the stream closes without a final blank line", async () => {
    const events = await collect(
      readSseEvents(streamOf(["event: ping\ndata: hi"])),
    );
    expect(events).toEqual([{ event: "ping", data: "hi", id: undefined }]);
  });

  test("passes through [DONE] sentinels as data", async () => {
    const events = await collect(readSseEvents(streamOf(["data: [DONE]\n\n"])));
    expect(events).toEqual([{ event: "", data: "[DONE]", id: undefined }]);
  });

  test("aborts when the signal fires before the next read", async () => {
    const controller = new AbortController();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls === 1) {
          c.enqueue(new TextEncoder().encode("event: a\ndata: 1\n\n"));
        } else {
          controller.abort();
          c.enqueue(new TextEncoder().encode("event: b\ndata: 2\n\n"));
        }
      },
    });

    const out: SseEvent[] = [];
    for await (const e of readSseEvents(stream, controller.signal)) {
      out.push(e);
      if (out.length === 1) controller.abort();
    }
    expect(out.map((e) => e.event)).toEqual(["a"]);
  });

  test("aborts an idle reader immediately via reader.cancel()", async () => {
    // Stream that sends one event then never resolves further reads — models
    // an upstream that has stopped sending data. Without `reader.cancel()`
    // the consumer would block forever after aborting.
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("event: a\ndata: 1\n\n"));
      },
      pull() {
        return new Promise<void>(() => {
          /* never resolves */
        });
      },
      cancel() {
        cancelled = true;
      },
    });

    const out: SseEvent[] = [];
    const iterator = readSseEvents(stream, controller.signal);
    const first = await iterator.next();
    if (!first.done) out.push(first.value);
    controller.abort();
    const second = await iterator.next();
    expect(second.done).toBe(true);
    expect(out.map((e) => e.event)).toEqual(["a"]);
    expect(cancelled).toBe(true);
  });

  test("does not dispatch a block whose only field is id: (spec compliance)", async () => {
    const events = await collect(
      readSseEvents(streamOf(["id: only\n\nevent: ping\ndata: hi\n\n"])),
    );
    expect(events).toEqual([{ event: "ping", data: "hi", id: undefined }]);
  });

  test("decodes a multi-byte UTF-8 character split across chunks", async () => {
    const checkBytes = new TextEncoder().encode("✓");
    expect(checkBytes.length).toBe(3);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: "));
        c.enqueue(checkBytes.subarray(0, 1));
        c.enqueue(checkBytes.subarray(1));
        c.enqueue(new TextEncoder().encode("\n\n"));
        c.close();
      },
    });
    const events = await collect(readSseEvents(stream));
    expect(events).toEqual([{ event: "", data: "✓", id: undefined }]);
  });
});
