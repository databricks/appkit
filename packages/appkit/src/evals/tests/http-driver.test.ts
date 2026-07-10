import { afterEach, describe, expect, test, vi } from "vitest";
import { createHttpDriver } from "../http-driver";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createHttpDriver", () => {
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
