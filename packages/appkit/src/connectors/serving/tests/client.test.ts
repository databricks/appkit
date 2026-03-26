import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { invoke, stream } from "../client";

const mockAuthenticate = vi.fn();

function createMockClient(host = "https://test.databricks.com") {
  return {
    config: {
      host,
      authenticate: mockAuthenticate,
    },
  } as any;
}

describe("Serving Connector", () => {
  beforeEach(() => {
    mockAuthenticate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("invoke", () => {
    test("constructs correct URL for endpoint invocation", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
        );

      const client = createMockClient();
      await invoke(client, "my-endpoint", { messages: [] });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.databricks.com/serving-endpoints/my-endpoint/invocations",
        expect.objectContaining({ method: "POST" }),
      );
    });

    test("constructs correct URL with servedModel override", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
        );

      const client = createMockClient();
      await invoke(
        client,
        "my-endpoint",
        { messages: [] },
        { servedModel: "llama-v2" },
      );

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://test.databricks.com/serving-endpoints/my-endpoint/served-models/llama-v2/invocations",
        expect.objectContaining({ method: "POST" }),
      );
    });

    test("authenticates request headers", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
      );

      const client = createMockClient();
      await invoke(client, "my-endpoint", { messages: [] });

      expect(mockAuthenticate).toHaveBeenCalledWith(expect.any(Headers));
    });

    test("strips stream property from body", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
        );

      const client = createMockClient();
      await invoke(client, "my-endpoint", {
        messages: [],
        stream: true,
        temperature: 0.7,
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual({ messages: [], temperature: 0.7 });
      expect(body.stream).toBeUndefined();
    });

    test("returns parsed JSON response", async () => {
      const responseData = { choices: [{ message: { content: "Hello" } }] };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(responseData), { status: 200 }),
      );

      const client = createMockClient();
      const result = await invoke(client, "my-endpoint", { messages: [] });

      expect(result).toEqual(responseData);
    });

    test("throws ApiError on 400 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "Invalid params" }), {
          status: 400,
        }),
      );

      const client = createMockClient();
      await expect(
        invoke(client, "my-endpoint", { messages: [] }),
      ).rejects.toThrow("Invalid params");
    });

    test("throws ApiError on 404 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "Endpoint not found" }), {
          status: 404,
        }),
      );

      const client = createMockClient();
      await expect(
        invoke(client, "my-endpoint", { messages: [] }),
      ).rejects.toThrow("Endpoint not found");
    });

    test("maps 5xx to 502 bad gateway", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "Internal error" }), {
          status: 500,
        }),
      );

      const client = createMockClient();
      try {
        await invoke(client, "my-endpoint", { messages: [] });
        expect.unreachable("Should have thrown");
      } catch (err: any) {
        expect(err.statusCode).toBe(502);
      }
    });

    test("forwards AbortSignal", async () => {
      const controller = new AbortController();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
        );

      const client = createMockClient();
      await invoke(
        client,
        "my-endpoint",
        { messages: [] },
        { signal: controller.signal },
      );

      expect(fetchSpy.mock.calls[0][1]?.signal).toBe(controller.signal);
    });

    test("throws when host is not configured", async () => {
      const client = {
        config: {
          host: "",
          authenticate: mockAuthenticate,
        },
      } as any;
      await expect(
        invoke(client, "my-endpoint", { messages: [] }),
      ).rejects.toThrow("Databricks host is not configured");
    });

    test("prepends https:// to host without protocol", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
        );

      const client = createMockClient("test.databricks.com");
      await invoke(client, "my-endpoint", { messages: [] });

      expect(fetchSpy.mock.calls[0][0]).toContain(
        "https://test.databricks.com",
      );
    });
  });

  describe("stream", () => {
    function createSSEResponse(chunks: string[]) {
      const body = `${chunks.join("\n")}\n`;
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    test("yields parsed NDJSON chunks", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        "data: [DONE]",
      ];

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        createSSEResponse(chunks),
      );

      const client = createMockClient();
      const results: unknown[] = [];
      for await (const chunk of stream(client, "my-endpoint", {
        messages: [],
      })) {
        results.push(chunk);
      }

      expect(results).toEqual([
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ]);
    });

    test("injects stream: true into body", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(createSSEResponse(["data: [DONE]"]));

      const client = createMockClient();
      // Consume the generator
      for await (const _ of stream(client, "my-endpoint", { messages: [] })) {
        // noop
      }

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.stream).toBe(true);
    });

    test("strips user-provided stream and re-injects", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(createSSEResponse(["data: [DONE]"]));

      const client = createMockClient();
      for await (const _ of stream(client, "my-endpoint", {
        messages: [],
        stream: false,
      })) {
        // noop
      }

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.stream).toBe(true);
    });

    test("skips SSE comments and empty lines", async () => {
      const chunks = [
        ": this is a comment",
        "",
        'data: {"choices":[{"delta":{"content":"Hi"}}]}',
        "",
        "data: [DONE]",
      ];

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        createSSEResponse(chunks),
      );

      const client = createMockClient();
      const results: unknown[] = [];
      for await (const chunk of stream(client, "my-endpoint", {
        messages: [],
      })) {
        results.push(chunk);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ choices: [{ delta: { content: "Hi" } }] });
    });

    test("throws on non-OK response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "Rate limited" }), {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
      );

      const client = createMockClient();
      try {
        for await (const _ of stream(client, "my-endpoint", { messages: [] })) {
          // noop
        }
        expect.unreachable("Should have thrown");
      } catch (err: any) {
        expect(err.statusCode).toBe(429);
      }
    });
  });
});
