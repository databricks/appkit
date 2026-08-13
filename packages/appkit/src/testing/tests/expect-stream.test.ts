import { describe, expect, test } from "vitest";
import { expectStream, parseSSEResponse } from "../expect-stream";
import { createMockResponse } from "../fixtures";

async function* asyncEvents<T>(events: T[]): AsyncGenerator<T> {
  for (const event of events) {
    yield event;
  }
}

/** Build a minimal SSE Response body from event frames. */
function sseResponse(
  frames: Array<{ event: string; data: unknown }>,
): Response {
  const body = frames
    .map(
      (f, i) =>
        `id: ${i}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`,
    )
    .join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("expectStream — async iterables (adapter output)", () => {
  test("toEmit matches an in-order subsequence, ignoring interleaved events", async () => {
    const stream = asyncEvents([
      { type: "metadata", data: { threadId: "t" } },
      { type: "tool_call", name: "highlight" },
      { type: "tool_result", output: "ok" },
      { type: "message_delta", content: "done" },
    ]);

    const types = await expectStream(stream).toEmit(
      "tool_call",
      "message_delta",
    );
    expect(types).toEqual([
      "metadata",
      "tool_call",
      "tool_result",
      "message_delta",
    ]);
  });

  test("toEmit rejects when an expected type is missing", async () => {
    const stream = asyncEvents([{ type: "message_delta" }]);
    await expect(expectStream(stream).toEmit("tool_call")).rejects.toThrow(
      /expected events.*tool_call.*in order/s,
    );
  });

  test("toEmit rejects when order is wrong", async () => {
    const stream = asyncEvents([
      { type: "message_delta" },
      { type: "tool_call" },
    ]);
    await expect(
      expectStream(stream).toEmit("tool_call", "message_delta"),
    ).rejects.toThrow(/in order/);
  });

  test("toEmitExactly requires the precise sequence", async () => {
    const events = [{ type: "a" }, { type: "b" }];
    await expect(
      expectStream(asyncEvents(events)).toEmitExactly("a", "b"),
    ).resolves.toEqual(["a", "b"]);
    await expect(
      expectStream(asyncEvents(events)).toEmitExactly("a"),
    ).rejects.toThrow(/exactly/);
  });

  test("collect and collectTypes return raw events and types", async () => {
    const events = [
      { type: "x", n: 1 },
      { type: "y", n: 2 },
    ];
    const assertion = expectStream(events);
    expect(await assertion.collectTypes()).toEqual(["x", "y"]);
    expect(await assertion.collect()).toEqual(events);
  });
});

describe("expectStream — sync iterables", () => {
  test("accepts a plain array of events", async () => {
    await expect(
      expectStream([{ type: "one" }, { type: "two" }]).toEmit("one", "two"),
    ).resolves.toBeDefined();
  });
});

describe("expectStream — SSE Response", () => {
  test("parses event frames and asserts order", async () => {
    const res = sseResponse([
      { event: "warehouse_status", data: { state: "RUNNING" } },
      { event: "result", data: { rows: [] } },
    ]);
    await expect(
      expectStream(res).toEmit("warehouse_status", "result"),
    ).resolves.toEqual(["warehouse_status", "result"]);
  });

  test("accepts a Promise<Response>", async () => {
    const res = Promise.resolve(
      sseResponse([{ event: "result", data: { ok: true } }]),
    );
    const events = await expectStream(res).collect();
    expect(events[0]).toMatchObject({ type: "result", ok: true });
  });

  test("ignores heartbeat/comment lines", async () => {
    const body = `: heartbeat\n\nid: 0\nevent: result\ndata: {"ok":true}\n\n`;
    const res = new Response(body);
    await expect(expectStream(res).toEmitExactly("result")).resolves.toEqual([
      "result",
    ]);
  });

  test("the wire event: name wins over a type field inside the data payload", async () => {
    // Regression: object spread must not let a `data` payload carrying its own
    // `type` override the frame's real event name. Here the wire says `error`
    // but the payload says `result`; the emitted event must be `error`.
    const body = `event: error\ndata: {"type":"result","message":"boom"}\n\n`;
    const res = new Response(body);
    const events = await expectStream(res).collect();
    expect(events[0]?.type).toBe("error");
    // A stream that actually errored must NOT satisfy an assertion for result.
    await expect(
      expectStream(new Response(body)).toEmitExactly("result"),
    ).rejects.toThrow(/exactly/);
  });

  test("drops a data-less named frame (real clients ignore it)", async () => {
    const body = `event: ping\n\nevent: result\ndata: {"ok":true}\n\n`;
    const res = new Response(body);
    await expect(expectStream(res).toEmitExactly("result")).resolves.toEqual([
      "result",
    ]);
  });

  test("parses CRLF-delimited frames from a spec-compliant SSE stream", async () => {
    // A real server may use \r\n\r\n between frames; AppKit's own writer uses
    // \n\n. Both must parse to distinct events, not one collapsed block.
    const body =
      'event: warehouse_status\r\ndata: {"state":"RUNNING"}\r\n\r\n' +
      'event: result\r\ndata: {"rows":[]}\r\n\r\n';
    const res = new Response(body);
    await expect(
      expectStream(res).toEmitExactly("warehouse_status", "result"),
    ).resolves.toEqual(["warehouse_status", "result"]);
  });

  // Data payloads that are not JSON objects. A JSON object spreads its fields
  // onto the event; anything else (scalar, array, non-JSON, multi-line) lands
  // under a `data` key. These pin the four non-object branches of parseSSEBody.
  test("a scalar JSON data value lands under `data`", async () => {
    const res = new Response("event: n\ndata: 42\n\n");
    const events = await expectStream(res).collect();
    expect(events[0]).toEqual({ type: "n", data: 42 });
  });

  test("an array JSON data value lands under `data` (not spread)", async () => {
    const res = new Response("event: xs\ndata: [1,2,3]\n\n");
    const events = await expectStream(res).collect();
    expect(events[0]).toEqual({ type: "xs", data: [1, 2, 3] });
  });

  test("a non-JSON data value is kept as a raw string", async () => {
    const res = new Response("event: note\ndata: plain text\n\n");
    const events = await expectStream(res).collect();
    expect(events[0]).toEqual({ type: "note", data: "plain text" });
  });

  test("multiple data: lines in one frame are joined with newlines", async () => {
    // Per the SSE spec, consecutive `data:` lines join with `\n`. Here the
    // joined value is not JSON, so it stays a string.
    const res = new Response(
      "event: multi\ndata: line one\ndata: line two\n\n",
    );
    const events = await expectStream(res).collect();
    expect(events[0]).toEqual({ type: "multi", data: "line one\nline two" });
  });
});

describe("expectStream — captured mock response", () => {
  // Write SSE frames the way the real SSEWriter does: three writes per frame
  // (`id:`, `event:`, `data:`), split across calls, terminated by a blank line.
  function writeFrame(
    res: ReturnType<typeof createMockResponse>,
    id: number,
    event: string,
    data: unknown,
  ) {
    res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  test("reads the SSE a handler wrote straight from the mock response", async () => {
    const res = createMockResponse();
    writeFrame(res, 0, "warehouse_status", { state: "RUNNING" });
    writeFrame(res, 1, "result", { rows: [] });
    res.end();

    await expect(
      expectStream(res).toEmitExactly("warehouse_status", "result"),
    ).resolves.toEqual(["warehouse_status", "result"]);
  });

  test("sseResponse() exposes the same bytes as a real Response", async () => {
    const res = createMockResponse();
    writeFrame(res, 0, "result", { ok: true });

    const events = await expectStream(res.sseResponse()).collect();
    expect(events[0]).toMatchObject({ type: "result", ok: true });
  });

  test("captures a final chunk passed to end()", async () => {
    const res = createMockResponse();
    res.write(`event: a\ndata: {}\n\n`);
    res.end(`event: b\ndata: {}\n\n`);

    await expect(expectStream(res).toEmitExactly("a", "b")).resolves.toEqual([
      "a",
      "b",
    ]);
  });
});

describe("expectStream — invalid source", () => {
  test("throws for a non-stream value", async () => {
    await expect(
      // Intentionally wrong type to exercise the runtime guard.
      expectStream(42 as unknown as never).collect(),
    ).rejects.toThrow(/async iterable, an iterable, or a Response/);
  });

  test("rejects a raw SSE body string with an actionable error", async () => {
    // A string is itself iterable (one char at a time), so silently walking it
    // would produce per-character "events". The guard must point to the fix.
    const body = `event: result\ndata: {"ok":true}\n\n`;
    await expect(
      expectStream(body as unknown as never).collect(),
    ).rejects.toThrow(/raw string.*sseResponse/s);
  });
});

describe("expectStream — timeout", () => {
  test("fails with a clear error when a stream never terminates", async () => {
    // A generator that yields once then hangs forever.
    async function* neverEnds(): AsyncGenerator<{ type: string }> {
      yield { type: "start" };
      await new Promise(() => {}); // never resolves
    }

    await expect(
      expectStream(neverEnds(), { timeout: 20 }).toEmit("start"),
    ).rejects.toThrow(/did not terminate within 20ms/);
  });

  test("a terminating stream resolves normally under a generous timeout", async () => {
    await expect(
      expectStream(asyncEvents([{ type: "a" }, { type: "b" }]), {
        timeout: 1000,
      }).toEmit("a", "b"),
    ).resolves.toEqual(["a", "b"]);
  });
});

describe("parseSSEResponse — single-event helper", () => {
  test("returns eventType plus parsed data fields", async () => {
    const res = new Response(
      `event: result\ndata: ${JSON.stringify({ value: 42 })}\n\n`,
    );
    const parsed = await parseSSEResponse(res);
    expect(parsed).toEqual({ eventType: "result", value: 42 });
  });

  test("throws when no data line is present", async () => {
    const res = new Response(`event: result\n\n`);
    await expect(parseSSEResponse(res)).rejects.toThrow(/No data found/);
  });
});
