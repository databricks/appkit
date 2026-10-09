import { afterEach, describe, expect, test, vi } from "vitest";

import { Context } from "../../../workspace-client";
import { invoke, stream } from "../client";

function createMockClient(host = "https://test.databricks.com") {
  return {
    config: { host },
    request: vi.fn(),
    apiClient: {
      request: vi.fn(),
    },
  } as any;
}

function createLegacyClient() {
  return { apiClient: { request: vi.fn() } } as any;
}

function jsonResponse(body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { headers });
}

function sentBody(client: any) {
  return JSON.parse(client.request.mock.calls[0][0].body);
}

describe("Serving Connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("invoke", () => {
    test("POSTs the body to the endpoint's invocations path", async () => {
      const client = createMockClient();
      const mockResponse = { choices: [{ message: { content: "Hello" } }] };
      client.request.mockResolvedValue(jsonResponse(mockResponse));

      const result = await invoke(client, "my-endpoint", {
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.7,
      });

      expect(client.request).toHaveBeenCalledWith({
        method: "POST",
        path: "/serving-endpoints/my-endpoint/invocations",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
          temperature: 0.7,
        }),
      });
      expect(result).toEqual(mockResponse);
    });

    test("strips stream property from body", async () => {
      const client = createMockClient();
      client.request.mockResolvedValue(jsonResponse({}));

      await invoke(client, "my-endpoint", {
        messages: [],
        stream: true,
        temperature: 0.7,
      });

      const queryArg = sentBody(client);
      expect(queryArg.stream).toBeUndefined();
      expect(queryArg.temperature).toBe(0.7);
    });

    // The legacy SDK's query() copied only its known request fields.
    test("sends only the fields the legacy query sent", async () => {
      const client = createMockClient();
      client.request.mockResolvedValue(jsonResponse({}));

      await invoke(client, "my-endpoint", {
        messages: [],
        max_tokens: 5,
        top_p: 0.9,
      });

      expect(sentBody(client)).toEqual({ messages: [], max_tokens: 5 });
    });

    // Responses are model-specific: nothing may be stripped.
    test("returns the raw JSON response, unknown fields included", async () => {
      const client = createMockClient();
      const responseData = {
        choices: [{ message: { content: "Hello" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
        model: "test-model",
        custom_field: { nested: [1, 2] },
      };
      client.request.mockResolvedValue(jsonResponse(responseData));

      const result = await invoke(client, "my-endpoint", { messages: [] });
      expect(result).toEqual(responseData);
    });

    test("merges the served-model-name header like the legacy query", async () => {
      const client = createMockClient();
      client.request.mockResolvedValue(
        jsonResponse({ predictions: [1] }, { "served-model-name": "m-1" }),
      );

      const result = await invoke(client, "my-endpoint", { inputs: [1] });
      expect(result).toEqual({ predictions: [1], "served-model-name": "m-1" });
    });

    test("returns {} for an empty body", async () => {
      const client = createMockClient();
      client.request.mockResolvedValue(new Response(""));

      expect(await invoke(client, "my-endpoint", {})).toEqual({});
    });

    test("throws the legacy message for a non-JSON body", async () => {
      const client = createMockClient();
      client.request.mockResolvedValue(new Response("oops"));

      await expect(invoke(client, "my-endpoint", {})).rejects.toThrow(
        "Can't parse reponse as JSON: oops",
      );
    });

    test("propagates SDK errors", async () => {
      const client = createMockClient();
      client.request.mockRejectedValue(new Error("Endpoint not found"));

      await expect(
        invoke(client, "my-endpoint", { messages: [] }),
      ).rejects.toThrow("Endpoint not found");
    });
  });

  describe("stream via client.request", () => {
    test("POSTs with stream: true and returns the response body", async () => {
      const client = createMockClient();
      const body = new ReadableStream<Uint8Array>();
      client.request.mockResolvedValue(new Response(body));
      const controller = new AbortController();

      const result = await stream(
        client,
        "my endpoint",
        { messages: [], stream: false },
        controller.signal,
      );

      expect(result).toBeInstanceOf(ReadableStream);
      expect(client.request).toHaveBeenCalledWith({
        method: "POST",
        path: "/serving-endpoints/my%20endpoint/invocations",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ messages: [], stream: true }),
        signal: controller.signal,
      });
      expect(client.apiClient.request).not.toHaveBeenCalled();
    });

    test("throws when the response has no body", async () => {
      const client = createMockClient();
      client.request.mockResolvedValue(new Response(null));

      await expect(
        stream(client, "my-endpoint", { messages: [] }),
      ).rejects.toThrow("streaming not supported");
    });
  });

  // Caller-supplied legacy SDK clients (agents' public `WorkspaceClientLike`)
  // have no `request`, so they keep the `apiClient.request` path.
  describe("stream via a legacy apiClient", () => {
    test("returns a ReadableStream from apiClient.request", async () => {
      const encoder = new TextEncoder();
      const mockContents = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: {}\n\n"));
          controller.close();
        },
      });

      const client = createLegacyClient();
      client.apiClient.request.mockResolvedValue({ contents: mockContents });

      const result = await stream(client, "my-endpoint", { messages: [] });

      expect(result).toBeInstanceOf(ReadableStream);
    });

    test("sends stream: true in payload via apiClient.request", async () => {
      const client = createLegacyClient();
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
        undefined,
      );
    });

    test("passes SDK Context when AbortSignal is provided", async () => {
      const client = createLegacyClient();
      client.apiClient.request.mockResolvedValue({
        contents: new ReadableStream(),
      });

      const controller = new AbortController();
      await stream(client, "my-endpoint", { messages: [] }, controller.signal);

      expect(client.apiClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/serving-endpoints/my-endpoint/invocations",
        }),
        expect.any(Context),
      );
    });

    test("strips user-provided stream and re-injects", async () => {
      const client = createLegacyClient();
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
      const client = createLegacyClient();
      client.apiClient.request.mockResolvedValue({ contents: null });

      await expect(
        stream(client, "my-endpoint", { messages: [] }),
      ).rejects.toThrow("streaming not supported");
    });
  });
});
