import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { createHttpDriver } from "../http-driver";

/**
 * A real SSE server, one behavior per path, so the driver's actual read loop
 * (heartbeat skipping, event-line parsing, timeout abort) is exercised end to
 * end rather than mocked.
 */
const server: Server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });

  switch (req.url) {
    // Happy path: a text delta then a normal end.
    case "/ok":
      res.write(
        `id: 1\nevent: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "Hello",
        })}\n\n`,
      );
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;

    // A thrown exception in the generator is framed by SSEWriter.writeError:
    // `event: error` with a payload that has NO `type` field.
    case "/thrown-error":
      res.write(
        `id: 1\nevent: error\ndata: ${JSON.stringify({
          error: "Internal server error",
          code: "INTERNAL_ERROR",
        })}\n\n`,
      );
      res.end();
      return;

    // Non-streaming adapter (e.g. LangChain): a full `message` item and NO
    // text deltas. The reply must come from the message item's content.
    case "/message-only":
      res.write(
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          item: { type: "message", content: [] },
        })}\n\n`,
      );
      res.write(
        `event: response.output_item.done\ndata: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "message",
            content: [{ type: "output_text", text: "the answer" }],
          },
        })}\n\n`,
      );
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;

    // Deltas followed by a terminal `message` that corrects them: the message
    // replaces the accumulated deltas rather than appending.
    case "/delta-then-message":
      res.write(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "partial",
        })}\n\n`,
      );
      res.write(
        `event: response.output_item.done\ndata: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "message",
            content: [{ type: "output_text", text: "full final content" }],
          },
        })}\n\n`,
      );
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;

    // A hung agent: heartbeat comments keep the socket alive but the stream
    // never ends. Deliberately never call res.end().
    default:
      res.write(`: heartbeat\n\n`);
      return;
  }
});

let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a mock SSE `Response` from a list of Responses-API events. */
function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("createHttpDriver", () => {
  test("captures the reply and succeeds on a normal stream", async () => {
    const driver = createHttpDriver({ baseUrl, path: "/ok" });
    const result = await driver.send("hi");
    expect(result.succeeded).toBe(true);
    expect(result.reply).toBe("Hello");
  });

  test("reports succeeded:false on a thrown-error frame (no false PASS)", async () => {
    const driver = createHttpDriver({ baseUrl, path: "/thrown-error" });
    const result = await driver.send("hi");
    expect(result.succeeded).toBe(false);
  });

  test("captures reply from a message item when there are no deltas", async () => {
    const driver = createHttpDriver({ baseUrl, path: "/message-only" });
    const result = await driver.send("hi");
    expect(result.succeeded).toBe(true);
    expect(result.reply).toBe("the answer");
  });

  test("a terminal message replaces accumulated deltas", async () => {
    const driver = createHttpDriver({ baseUrl, path: "/delta-then-message" });
    const result = await driver.send("hi");
    expect(result.succeeded).toBe(true);
    expect(result.reply).toBe("full final content");
  });

  test("times out a hung stream instead of hanging forever", async () => {
    const driver = createHttpDriver({
      baseUrl,
      path: "/stall",
      timeoutMs: 150,
    });
    const started = Date.now();
    const result = await driver.send("hi");
    expect(result.succeeded).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("captures tool-call names and parses their arguments", async () => {
    // `added` carries empty args; `done` carries the full JSON string.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            name: "get_weather",
            call_id: "c1",
            arguments: "",
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "get_weather",
            call_id: "c1",
            arguments: '{"city":"Paris","units":"metric"}',
          },
        },
        { type: "response.output_text.delta", delta: "Sunny" },
      ]),
    );

    const driver = createHttpDriver({ baseUrl: "http://localhost:3000" });
    const result = await driver.send("weather in Paris?");

    expect(result.reply).toBe("Sunny");
    expect(result.toolCalls).toEqual(["get_weather"]);
    expect(result.toolCallDetails).toEqual([
      { name: "get_weather", args: { city: "Paris", units: "metric" } },
    ]);
    expect(result.succeeded).toBe(true);
  });

  test("defaults args to {} when the arguments JSON is malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "broken",
            call_id: "c1",
            arguments: "{not json",
          },
        },
      ]),
    );

    const driver = createHttpDriver({ baseUrl: "http://localhost:3000" });
    const result = await driver.send("go");

    expect(result.toolCallDetails).toEqual([{ name: "broken", args: {} }]);
  });
});
