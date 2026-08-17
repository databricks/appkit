import http from "node:http";
import {
  context,
  createTraceState,
  propagation,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { Context, createWorkspaceClient } from "../../../workspace-client";
import { getResponseHeaders, invoke, stream } from "../client";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;
const W3C_PROPAGATOR = new W3CTraceContextPropagator();

beforeAll(() => {
  context.disable();
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.disable();
  propagation.setGlobalPropagator(W3C_PROPAGATOR);
});

afterAll(() => {
  propagation.disable();
  context.disable();
});

function withActiveTrace<T>(operation: () => T, spanId = SPAN_ID): T {
  const span = trace.wrapSpanContext({
    traceId: TRACE_ID,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    traceState: createTraceState("vendor=value"),
  });
  return context.with(trace.setSpan(context.active(), span), operation);
}

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
    test("injects after SDK authentication on every request and preserves final wire headers", async () => {
      const secondSpanId = "fedcba9876543210";
      const order: string[] = [];
      const wireHeaders: http.IncomingHttpHeaders[] = [];
      let authentication = 0;
      const server = http.createServer((request, response) => {
        order.push(`wire:${wireHeaders.length + 1}`);
        wireHeaders.push(request.headers);
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end("data: {}\n\n");
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind SDK wire-test server");
      }
      const client = createWorkspaceClient({
        host: `http://127.0.0.1:${address.port}`,
        token: "sdk-test-token",
        authType: "pat",
      });
      const originalAuthenticate = client.config.authenticate.bind(
        client.config,
      );
      vi.spyOn(client.config, "authenticate").mockImplementation(
        async (headers) => {
          authentication++;
          order.push(`auth:${authentication}`);
          await originalAuthenticate(headers);
          headers.set("Authorization", `Bearer fresh-${authentication}`);
          headers.set(
            "traceparent",
            "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
          );
          headers.set("tracestate", "auth=stale");
        },
      );
      const originalInject = W3C_PROPAGATOR.inject.bind(W3C_PROPAGATOR);
      vi.spyOn(W3C_PROPAGATOR, "inject").mockImplementation(
        (activeContext, carrier, setter) => {
          order.push(`inject:${authentication}`);
          originalInject(activeContext, carrier, setter);
        },
      );

      try {
        await withActiveTrace(() =>
          stream(client, "my-endpoint", { messages: [] }),
        );
        await withActiveTrace(
          () => stream(client, "my-endpoint", { messages: [] }),
          secondSpanId,
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      expect(order).toEqual([
        "auth:1",
        "inject:1",
        "wire:1",
        "auth:2",
        "inject:2",
        "wire:2",
      ]);
      expect(
        wireHeaders.map((headers) => ({
          authorization: headers.authorization,
          traceparent: headers.traceparent,
          tracestate: headers.tracestate,
          contentType: headers["content-type"],
          accept: headers.accept,
        })),
      ).toEqual([
        {
          authorization: "Bearer fresh-1",
          traceparent: TRACEPARENT,
          tracestate: "vendor=value",
          contentType: "application/json",
          accept: "text/event-stream",
        },
        {
          authorization: "Bearer fresh-2",
          traceparent: `00-${TRACE_ID}-${secondSpanId}-01`,
          tracestate: "vendor=value",
          contentType: "application/json",
          accept: "text/event-stream",
        },
      ]);
    });

    test("injects the active W3C context into the actual SDK streaming request", async () => {
      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({
        contents: new ReadableStream(),
      });

      await withActiveTrace(() =>
        stream(client, "my-endpoint", { messages: [] }),
      );

      const [request] = client.apiClient.request.mock.calls[0];
      const headers = new Headers(request.headers);
      expect(headers.get("traceparent")).toBe(TRACEPARENT);
      expect(headers.get("tracestate")).toBe("vendor=value");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("accept")).toBe("text/event-stream");
    });

    test("does not add W3C headers when no valid span is active", async () => {
      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({
        contents: new ReadableStream(),
      });

      await stream(client, "my-endpoint", { messages: [] });

      const [request] = client.apiClient.request.mock.calls[0];
      const headers = new Headers(request.headers);
      expect(headers.get("traceparent")).toBeNull();
      expect(headers.get("tracestate")).toBeNull();
    });

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

    test("retains response headers on the returned stream", async () => {
      const contents = new ReadableStream<Uint8Array>();
      const client = createMockClient();
      client.apiClient.request.mockResolvedValue({
        contents,
        headers: new Headers({
          "x-databricks-trace-id":
            "trace:/main.agent_traces.appkit/remote-trace",
        }),
      });

      const result = await stream(client, "my-endpoint", { messages: [] });

      expect(getResponseHeaders(result)?.get("x-databricks-trace-id")).toBe(
        "trace:/main.agent_traces.appkit/remote-trace",
      );
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
        undefined,
      );
    });

    test("passes SDK Context when AbortSignal is provided", async () => {
      const client = createMockClient();
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
