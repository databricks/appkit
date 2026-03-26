import type { AgentEvent, AgentToolDefinition, Message } from "shared";
import { afterEach, describe, expect, test, vi } from "vitest";
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

function createAdapter(
  overrides?: Partial<ConstructorParameters<typeof DatabricksAdapter>[0]>,
) {
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

    const adapter = createAdapter({ systemPrompt: "Be helpful" });

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
      role: "system",
      content: "Be helpful",
    });
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
});

describe("DatabricksAdapter.fromServingEndpoint", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("builds endpointUrl from config host and endpoint name", async () => {
    globalThis.fetch = mockFetch([textDelta("Hi"), sseChunk("[DONE]")]);

    const mockConfig = {
      host: "https://my-workspace.databricks.com",
      ensureResolved: vi.fn().mockResolvedValue(undefined),
      authenticate: vi.fn().mockImplementation(async (h: Headers) => {
        h.set("Authorization", "Bearer fresh-token");
      }),
    };

    const adapter = await DatabricksAdapter.fromServingEndpoint({
      workspaceClient: { config: mockConfig },
      endpointName: "my-model",
    });

    for await (const _ of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(
      "https://my-workspace.databricks.com/serving-endpoints/my-model/invocations",
    );
    expect(init.headers.authorization).toBe("Bearer fresh-token");
    expect(mockConfig.ensureResolved).toHaveBeenCalled();
    expect(mockConfig.authenticate).toHaveBeenCalled();
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
});
