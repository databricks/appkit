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
    test("returns a ReadableStream from apiClient.request", async () => {
      const encoder = new TextEncoder();
      const mockContents = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: {}\n\n"));
          controller.close();
        },
      });

      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({ contents: mockContents });

      const result = await stream(client, "my-endpoint", { messages: [] });

      expect(result).toBeInstanceOf(ReadableStream);
    });

    test("sends stream: true in payload via apiClient.request", async () => {
      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({
        contents: new ReadableStream(),
      });

      await stream(client, "my-endpoint", { messages: [] });

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
        contents: new ReadableStream(),
      });

      await stream(client, "my-endpoint", {
        messages: [],
        stream: false,
      });

      const payload = client.apiClient.request.mock.calls[0][0].payload;
      expect(payload.stream).toBe(true);
    });

    test("throws when response has no contents", async () => {
      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({ contents: null });

      await expect(
        stream(client, "my-endpoint", { messages: [] }),
      ).rejects.toThrow("streaming not supported");
    });
  });
});
