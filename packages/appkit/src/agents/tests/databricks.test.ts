import type { AgentEvent, AgentToolDefinition, Message } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DatabricksAdapter, parseTextToolCalls } from "../databricks";

const mockAuthenticate = vi
  .fn()
  .mockResolvedValue({ Authorization: "Bearer test-token" });

function sseChunk(data: string): string {
  return `data: ${data}\n\n`;
}

function textDelta(content: string): string {
  return sseChunk(
    JSON.stringify({
      choices: [{ delta: { content } }],
    }),
  );
}

function toolCallDelta(
  index: number,
  id: string | undefined,
  name: string | undefined,
  args: string,
): string {
  return sseChunk(
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                ...(id && { id }),
                ...(name && { type: "function" }),
                function: {
                  ...(name && { name }),
                  arguments: args,
                },
              },
            ],
          },
        },
      ],
    }),
  );
}

function createReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
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

function mockFetch(chunks: string[]): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    body: createReadableStream(chunks),
    text: () => Promise.resolve(""),
  });
}

function createTestMessages(): Message[] {
  return [{ id: "1", role: "user", content: "Hello", createdAt: new Date() }];
}

function createTestTools(): AgentToolDefinition[] {
  return [
    {
      name: "analytics.query",
      description: "Run SQL",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ];
}

function createAdapter(overrides?: {
  endpointUrl?: string;
  authenticate?: () => Promise<Record<string, string>>;
  maxSteps?: number;
  maxTokens?: number;
  maxSseLineChars?: number;
  maxStreamTextChars?: number;
  maxToolArgumentsChars?: number;
}) {
  return new DatabricksAdapter({
    endpointUrl:
      "https://test.databricks.com/serving-endpoints/my-endpoint/invocations",
    authenticate: mockAuthenticate,
    ...overrides,
  });
}

describe("DatabricksAdapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockAuthenticate.mockClear();
  });

  test("streams text deltas from the model", async () => {
    globalThis.fetch = mockFetch([
      textDelta("Hello"),
      textDelta(" world"),
      sseChunk("[DONE]"),
    ]);

    const adapter = createAdapter();
    const events: AgentEvent[] = [];

    for await (const event of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "status", status: "running" });
    expect(events[1]).toEqual({ type: "message_delta", content: "Hello" });
    expect(events[2]).toEqual({ type: "message_delta", content: " world" });
  });

  test("calls authenticate() per request for fresh headers", async () => {
    globalThis.fetch = mockFetch([textDelta("Hi"), sseChunk("[DONE]")]);

    const adapter = createAdapter();

    for await (const _ of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    expect(mockAuthenticate).toHaveBeenCalledTimes(1);

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-token");
  });

  test("throws when two tool names map to the same wire format", async () => {
    const adapter = createAdapter();
    const conflictingTools: AgentToolDefinition[] = [
      {
        name: "foo.bar",
        description: "one",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "foo__bar",
        description: "two",
        parameters: { type: "object", properties: {} },
      },
    ];

    await expect(async () => {
      for await (const _ of adapter.run(
        {
          messages: createTestMessages(),
          tools: conflictingTools,
          threadId: "t1",
        },
        { executeTool: vi.fn() },
      )) {
        // drain
      }
    }).rejects.toThrow(
      /Tool name collision: .* both map to wire name 'foo__bar'/,
    );
  });

  test("handles structured tool calls and executes them", async () => {
    const executeTool = vi.fn().mockResolvedValue([{ trip_id: 1 }]);

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          body: createReadableStream([
            toolCallDelta(0, "call_1", "analytics__query", ""),
            toolCallDelta(0, undefined, undefined, '{"query":'),
            toolCallDelta(0, undefined, undefined, '"SELECT 1"}'),
            sseChunk("[DONE]"),
          ]),
        });
      }
      return Promise.resolve({
        ok: true,
        body: createReadableStream([
          textDelta("Here are the results"),
          sseChunk("[DONE]"),
        ]),
      });
    });

    const adapter = createAdapter();
    const events: AgentEvent[] = [];

    for await (const event of adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "tool_call",
      callId: "call_1",
      name: "analytics.query",
      args: { query: "SELECT 1" },
    });

    expect(executeTool).toHaveBeenCalledWith("analytics.query", {
      query: "SELECT 1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        callId: "call_1",
        result: [{ trip_id: 1 }],
      }),
    );

    expect(events).toContainEqual({
      type: "message_delta",
      content: "Here are the results",
    });

    // authenticate() called once per streamCompletion
    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
  });

  test("text-parsed tool calls use wire names on follow-up requests", async () => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    let callCount = 0;

    const llamaToolJson =
      '[{"name": "analytics.query", "parameters": {"query": "SELECT 1"}}]';

    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          body: createReadableStream([
            textDelta(llamaToolJson),
            sseChunk("[DONE]"),
          ]),
        });
      }
      return Promise.resolve({
        ok: true,
        body: createReadableStream([textDelta("Done."), sseChunk("[DONE]")]),
      });
    });

    const adapter = createAdapter();

    for await (const _ of adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool },
    )) {
      // drain
    }

    expect(executeTool).toHaveBeenCalledWith("analytics.query", {
      query: "SELECT 1",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const [, secondInit] = (globalThis.fetch as any).mock.calls[1];
    const secondBody = JSON.parse(secondInit.body);

    expect(secondBody.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "text_call_0",
          type: "function",
          function: {
            name: "analytics__query",
            arguments: JSON.stringify({ query: "SELECT 1" }),
          },
        },
      ],
    });

    expect(secondBody.messages[2]).toEqual({
      role: "tool",
      content: JSON.stringify({ ok: true }),
      tool_call_id: "text_call_0",
    });
  });

  test("respects maxSteps limit", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        body: createReadableStream([
          toolCallDelta(
            0,
            "call_loop",
            "analytics__query",
            '{"query":"SELECT 1"}',
          ),
          sseChunk("[DONE]"),
        ]),
      }),
    );

    const adapter = createAdapter({ maxSteps: 2 });
    const events: AgentEvent[] = [];

    for await (const event of adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool: vi.fn().mockResolvedValue("ok") },
    )) {
      events.push(event);
    }

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("sends correct request to endpoint URL", async () => {
    globalThis.fetch = mockFetch([textDelta("Hi"), sseChunk("[DONE]")]);

    const adapter = createAdapter();

    for await (const _ of adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(
      "https://test.databricks.com/serving-endpoints/my-endpoint/invocations",
    );

    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("analytics__query");
    expect(body.messages[0]).toEqual({
      role: "user",
      content: "Hello",
    });
  });

  test("forwards tool thread fields from input messages to the request body", async () => {
    globalThis.fetch = mockFetch([textDelta("Done"), sseChunk("[DONE]")]);

    const adapter = createAdapter();

    const threadMessages: Message[] = [
      { id: "1", role: "user", content: "Run SQL", createdAt: new Date() },
      {
        id: "2",
        role: "assistant",
        content: "",
        createdAt: new Date(),
        toolCalls: [
          {
            id: "call_1",
            name: "analytics.query",
            args: { query: "SELECT 1" },
          },
        ],
      },
      {
        id: "3",
        role: "tool",
        content: '{"rows":[]}',
        createdAt: new Date(),
        toolCallId: "call_1",
      },
    ];

    for await (const _ of adapter.run(
      {
        messages: threadMessages,
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "analytics__query",
            arguments: JSON.stringify({ query: "SELECT 1" }),
          },
        },
      ],
    });

    expect(body.messages[2]).toEqual({
      role: "tool",
      content: '{"rows":[]}',
      tool_call_id: "call_1",
    });
  });

  test("throws when SSE line buffer exceeds maxSseLineChars", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream(["no-newline-", "xxxxxxxxxx"]),
      text: () => Promise.resolve(""),
    });

    const adapter = createAdapter({ maxSseLineChars: 12 });

    await expect(async () => {
      for await (const _ of adapter.run(
        { messages: createTestMessages(), tools: [], threadId: "t1" },
        { executeTool: vi.fn() },
      )) {
        // drain
      }
    }).rejects.toThrow(/SSE line buffer exceeds configured limit/);
  });

  test("throws when a complete SSE line exceeds maxSseLineChars", async () => {
    const longPayload = `${"x".repeat(30)}\n`;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream([longPayload]),
      text: () => Promise.resolve(""),
    });

    const adapter = createAdapter({ maxSseLineChars: 20 });

    await expect(async () => {
      for await (const _ of adapter.run(
        { messages: createTestMessages(), tools: [], threadId: "t1" },
        { executeTool: vi.fn() },
      )) {
        // drain
      }
    }).rejects.toThrow(/SSE line exceeds configured limit/);
  });

  test("throws when streamed assistant text exceeds maxStreamTextChars", async () => {
    globalThis.fetch = mockFetch([
      textDelta("abcde"),
      textDelta("f"),
      sseChunk("[DONE]"),
    ]);

    const adapter = createAdapter({ maxStreamTextChars: 5 });

    await expect(async () => {
      for await (const _ of adapter.run(
        { messages: createTestMessages(), tools: [], threadId: "t1" },
        { executeTool: vi.fn() },
      )) {
        // drain
      }
    }).rejects.toThrow(/streamed assistant text exceeds configured limit/);
  });

  test("throws when streamed tool arguments exceed maxToolArgumentsChars", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream([
        toolCallDelta(0, "c1", "t", '{"a":"'),
        toolCallDelta(0, undefined, undefined, 'xxxx"}'),
        sseChunk("[DONE]"),
      ]),
      text: () => Promise.resolve(""),
    });

    const adapter = createAdapter({ maxToolArgumentsChars: 8 });

    await expect(async () => {
      for await (const _ of adapter.run(
        {
          messages: createTestMessages(),
          tools: [
            {
              name: "t",
              description: "x",
              parameters: { type: "object", properties: {} },
            },
          ],
          threadId: "t1",
        },
        { executeTool: vi.fn().mockResolvedValue("ok") },
      )) {
        // drain
      }
    }).rejects.toThrow(/tool call arguments exceed/);
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const adapter = createAdapter();

    await expect(async () => {
      for await (const _ of adapter.run(
        { messages: createTestMessages(), tools: [], threadId: "t1" },
        { executeTool: vi.fn() },
      )) {
        // drain
      }
    }).rejects.toThrow("Databricks API error (401): Unauthorized");
  });

  test("yields error status then throws when injected streamBody fails", async () => {
    const adapter = new DatabricksAdapter({
      streamBody: async () => Promise.reject(new Error("serving_unreachable")),
      maxSteps: 1,
    });

    const events: AgentEvent[] = [];
    await expect(async () => {
      for await (const ev of adapter.run(
        { messages: createTestMessages(), tools: [], threadId: "t1" },
        { executeTool: vi.fn() },
      )) {
        events.push(ev);
      }
    }).rejects.toThrow("serving_unreachable");

    expect(events[0]).toEqual({ type: "status", status: "running" });
    expect(events[1]).toEqual({
      type: "status",
      status: "error",
      error: "serving_unreachable",
    });
  });

  test("yields tool_result with error when executeTool rejects", async () => {
    const executeTool = vi.fn().mockRejectedValue(new Error("tool_denied"));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream([
        toolCallDelta(
          0,
          "call_fail",
          "analytics__query",
          '{"query":"SELECT 2"}',
        ),
        sseChunk("[DONE]"),
      ]),
      text: () => Promise.resolve(""),
    });

    const adapter = createAdapter({ maxSteps: 1 });
    const events: AgentEvent[] = [];

    for await (const ev of adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool },
    )) {
      events.push(ev);
    }

    expect(events).toContainEqual({
      type: "tool_call",
      callId: "call_fail",
      name: "analytics.query",
      args: { query: "SELECT 2" },
    });

    expect(events).toContainEqual({
      type: "tool_result",
      callId: "call_fail",
      result: null,
      error: "tool_denied",
    });

    expect(executeTool).toHaveBeenCalledWith("analytics.query", {
      query: "SELECT 2",
    });
  });

  test("uses AbortSignal.timeout for raw fetch when context has no signal", async () => {
    globalThis.fetch = mockFetch([textDelta("Hello"), sseChunk("[DONE]")]);

    const ac = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(ac.signal);

    const adapter = createAdapter();

    for await (const _ of adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool: vi.fn(), signal: undefined },
    )) {
      // drain
    }

    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    timeoutSpy.mockRestore();
  });

  test("logs and skips malformed JSON in SSE lines", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    globalThis.fetch = mockFetch([
      sseChunk("{not-json-truncated"),
      textDelta("ok"),
      sseChunk("[DONE]"),
    ]);

    const adapter = createAdapter();
    const events: AgentEvent[] = [];

    for await (const ev of adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool: vi.fn() },
    )) {
      events.push(ev);
    }

    expect(
      debugSpy.mock.calls.some(([msg]) => {
        return typeof msg === "string" && msg.includes("malformed SSE");
      }),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "message_delta" && e.content === "ok"),
    ).toBe(true);
    debugSpy.mockRestore();
  });
});

describe("DatabricksAdapter.fromServingEndpoint", () => {
  test("routes tool-free chat through apiClient.request with a streaming payload", async () => {
    const apiClient = {
      request: vi.fn().mockResolvedValue({
        contents: createReadableStream([textDelta("Hi"), sseChunk("[DONE]")]),
      }),
    };

    const adapter = await DatabricksAdapter.fromServingEndpoint({
      workspaceClient: { apiClient },
      endpointName: "my-model",
    });

    for await (const _ of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    expect(apiClient.request).toHaveBeenCalledTimes(1);
    const [requestArgs] = apiClient.request.mock.calls[0];
    expect(requestArgs.path).toBe("/serving-endpoints/my-model/invocations");
    expect(requestArgs.method).toBe("POST");
    expect(requestArgs.raw).toBe(true);
    expect(requestArgs.payload.stream).toBe(true);
    // Auth + url encoding are the connector's (and the SDK's) concerns — the
    // adapter no longer reaches into the workspace config.
  });

  test("URL-encodes endpoint names with special characters", async () => {
    const apiClient = {
      request: vi.fn().mockResolvedValue({
        contents: createReadableStream([textDelta("Hi"), sseChunk("[DONE]")]),
      }),
    };

    const adapter = await DatabricksAdapter.fromServingEndpoint({
      workspaceClient: { apiClient },
      endpointName: "my model/with spaces",
    });

    for await (const _ of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    const [requestArgs] = apiClient.request.mock.calls[0];
    expect(requestArgs.path).toBe(
      "/serving-endpoints/my%20model%2Fwith%20spaces/invocations",
    );
  });
});

describe("DatabricksAdapter.fromModelServing", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("reads endpoint from DATABRICKS_SERVING_ENDPOINT_NAME env var", async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = "my-model";

    vi.mock("@databricks/sdk-experimental", () => ({
      WorkspaceClient: vi.fn().mockImplementation(() => ({
        apiClient: { request: vi.fn() },
      })),
    }));

    const adapter = await DatabricksAdapter.fromModelServing();
    expect(adapter).toBeInstanceOf(DatabricksAdapter);
  });

  test("throws when no endpoint name and no env var", async () => {
    delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;

    await expect(DatabricksAdapter.fromModelServing()).rejects.toThrow(
      "No endpoint name provided",
    );
  });

  test("explicit endpoint name takes precedence over env var", async () => {
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = "env-model";

    const apiClient = {
      request: vi.fn().mockResolvedValue({
        contents: createReadableStream([textDelta("Hi"), sseChunk("[DONE]")]),
      }),
    };

    const adapter = await DatabricksAdapter.fromModelServing("explicit-model", {
      workspaceClient: { apiClient },
    });

    expect(adapter).toBeInstanceOf(DatabricksAdapter);

    for await (const _ of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    const [requestArgs] = apiClient.request.mock.calls[0];
    expect(requestArgs.path).toBe(
      "/serving-endpoints/explicit-model/invocations",
    );
  });
});

describe("parseTextToolCalls", () => {
  test("parses Llama JSON format", () => {
    const text =
      '[{"name": "analytics.query", "parameters": {"query": "SELECT 1"}}]';
    const result = parseTextToolCalls(text);

    expect(result).toEqual([
      { name: "analytics.query", args: { query: "SELECT 1" } },
    ]);
  });

  test("parses multiple Llama JSON tool calls", () => {
    const text =
      '[{"name": "analytics.query", "parameters": {"query": "SELECT 1"}}, {"name": "files.uploads.list", "parameters": {}}]';
    const result = parseTextToolCalls(text);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("analytics.query");
    expect(result[1].name).toBe("files.uploads.list");
  });

  test("parses Python-style tool calls", () => {
    const text =
      "[analytics.query(query='SELECT * FROM trips ORDER BY date DESC LIMIT 10')]";
    const result = parseTextToolCalls(text);

    expect(result).toEqual([
      {
        name: "analytics.query",
        args: {
          query: "SELECT * FROM trips ORDER BY date DESC LIMIT 10",
        },
      },
    ]);
  });

  test("parses Python-style with multiple args", () => {
    const text =
      "[files.uploads.read(path='/data/file.csv', encoding='utf-8')]";
    const result = parseTextToolCalls(text);

    expect(result).toEqual([
      {
        name: "files.uploads.read",
        args: { path: "/data/file.csv", encoding: "utf-8" },
      },
    ]);
  });

  test("returns empty array for plain text", () => {
    expect(parseTextToolCalls("Hello, how can I help?")).toEqual([]);
    expect(parseTextToolCalls("")).toEqual([]);
    expect(parseTextToolCalls("The answer is 42")).toEqual([]);
  });

  test("handles Llama format with 'arguments' key", () => {
    const text =
      '[{"name": "lakebase.query", "arguments": {"text": "SELECT 1"}}]';
    const result = parseTextToolCalls(text);

    expect(result).toEqual([
      { name: "lakebase.query", args: { text: "SELECT 1" } },
    ]);
  });

  test("returns empty when Python-style fallback text exceeds size cap", () => {
    const cap = 64 * 1024;
    const filler = "x".repeat(cap);
    const suffix = "[analytics.query(query='SELECT 1')]";
    expect(parseTextToolCalls(`${filler}${suffix}`)).toEqual([]);
  });
});
