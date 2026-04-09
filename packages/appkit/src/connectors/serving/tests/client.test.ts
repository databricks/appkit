import { afterEach, describe, expect, test, vi } from "vitest";
import { invoke, stream } from "../client";

function createMockClient(host = "https://test.databricks.com") {
  return {
    config: { host },
    servingEndpoints: {
      query: vi.fn(),
    },
    apiClient: {
      request: vi.fn(),
    },
  } as any;
}

describe("Serving Connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("invoke", () => {
    test("calls servingEndpoints.query with endpoint name and body", async () => {
      const client = createMockClient();
      const mockResponse = { choices: [{ message: { content: "Hello" } }] };
      client.servingEndpoints.query.mockResolvedValue(mockResponse);

      const result = await invoke(client, "my-endpoint", {
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.7,
      });

      expect(client.servingEndpoints.query).toHaveBeenCalledWith({
        name: "my-endpoint",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.7,
      });
      expect(result).toEqual(mockResponse);
    });

    test("strips stream property from body", async () => {
      const client = createMockClient();
      client.servingEndpoints.query.mockResolvedValue({});

      await invoke(client, "my-endpoint", {
        messages: [],
        stream: true,
        temperature: 0.7,
      });

      const queryArg = client.servingEndpoints.query.mock.calls[0][0];
      expect(queryArg.stream).toBeUndefined();
      expect(queryArg.temperature).toBe(0.7);
    });

    test("returns typed QueryEndpointResponse", async () => {
      const client = createMockClient();
      const responseData = {
        choices: [{ message: { content: "Hello" } }],
        model: "test-model",
      };
      client.servingEndpoints.query.mockResolvedValue(responseData);

      const result = await invoke(client, "my-endpoint", { messages: [] });
      expect(result).toEqual(responseData);
    });

    test("propagates SDK errors", async () => {
      const client = createMockClient();
      client.servingEndpoints.query.mockRejectedValue(
        new Error("Endpoint not found"),
      );

      await expect(
        invoke(client, "my-endpoint", { messages: [] }),
      ).rejects.toThrow("Endpoint not found");
    });
  });

  describe("stream", () => {
    function createSSEStream(chunks: string[]) {
      const body = `${chunks.join("\n")}\n`;
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      });
    }

    test("yields parsed NDJSON chunks", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        "data: [DONE]",
      ];

      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({
        contents: createSSEStream(chunks),
      });

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

    test("sends stream: true in payload via apiClient.request", async () => {
      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({
        contents: createSSEStream(["data: [DONE]"]),
      });

      for await (const _ of stream(client, "my-endpoint", { messages: [] })) {
        // noop
      }

      expect(client.apiClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/serving-endpoints/my-endpoint/invocations",
          method: "POST",
          raw: true,
          payload: expect.objectContaining({ stream: true }),
        }),
      );
    });

    test("strips user-provided stream and re-injects", async () => {
      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({
        contents: createSSEStream(["data: [DONE]"]),
      });

      for await (const _ of stream(client, "my-endpoint", {
        messages: [],
        stream: false,
      })) {
        // noop
      }

      const payload = client.apiClient.request.mock.calls[0][0].payload;
      expect(payload.stream).toBe(true);
    });

    test("skips SSE comments and empty lines", async () => {
      const chunks = [
        ": this is a comment",
        "",
        'data: {"choices":[{"delta":{"content":"Hi"}}]}',
        "",
        "data: [DONE]",
      ];

      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({
        contents: createSSEStream(chunks),
      });

      const results: unknown[] = [];
      for await (const chunk of stream(client, "my-endpoint", {
        messages: [],
      })) {
        results.push(chunk);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ choices: [{ delta: { content: "Hi" } }] });
    });

    test("throws when response has no contents", async () => {
      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({ contents: null });

      try {
        for await (const _ of stream(client, "my-endpoint", {
          messages: [],
        })) {
          // noop
        }
        expect.unreachable("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("streaming not supported");
      }
    });

    test("throws when buffer exceeds max size", async () => {
      const client = createMockClient();
      const largeData = "x".repeat(1024 * 1024 + 1);
      const encoder = new TextEncoder();
      const largeStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(largeData));
          controller.close();
        },
      });
      client.apiClient.request.mockResolvedValue({
        contents: largeStream,
      });

      try {
        for await (const _ of stream(client, "my-endpoint", {
          messages: [],
        })) {
          // noop
        }
        expect.unreachable("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("Stream buffer exceeded");
      }
    });
  });
});
