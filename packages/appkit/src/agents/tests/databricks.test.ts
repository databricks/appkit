import type { AgentEvent, AgentToolDefinition, Message } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DatabricksAdapter,
  type GenerationParams,
  parseTextToolCalls,
} from "../databricks";

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

function harmonyDelta(parts: unknown[]): string {
  return sseChunk(
    JSON.stringify({
      choices: [{ delta: { content: parts } }],
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
  generationParams?: GenerationParams;
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

  test("extracts answer text from harmony array-shaped delta.content", async () => {
    globalThis.fetch = mockFetch([
      harmonyDelta([
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "...answer the user." }],
        },
        { type: "text", text: "The default port is 8443." },
      ]),
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

    expect(events).toContainEqual({
      type: "message_delta",
      content: "The default port is 8443.",
    });
    expect(events).toContainEqual({
      type: "thinking",
      content: "...answer the user.",
    });
    // Reasoning must not leak into the answer: exactly one message_delta.
    expect(events.filter((e) => e.type === "message_delta")).toHaveLength(1);
  });

  test("reasoning-only harmony delta yields thinking but no answer text", async () => {
    globalThis.fetch = mockFetch([
      harmonyDelta([
        {
          type: "reasoning",
          summary: [
            { type: "summary_text", text: "We have the search result..." },
          ],
        },
      ]),
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

    expect(events.filter((e) => e.type === "message_delta")).toHaveLength(0);
    expect(events).toContainEqual({
      type: "thinking",
      content: "We have the search result...",
    });
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

  // Regression for #558: a custom tool's result must ground a gpt-oss answer
  // that streams back as an array-shaped delta.content. The result reaching
  // the model and the array answer being captured are the two failure points.
  test("grounds a gpt-oss array-shaped answer in a tool result", async () => {
    const toolResult = [
      {
        n: 1,
        source: "test",
        text: "The HTTPS ingest API default port is 8443.",
      },
    ];
    const executeTool = vi.fn().mockResolvedValue(toolResult);
    const searchTools: AgentToolDefinition[] = [
      {
        name: "search_docs",
        description: "Search product docs.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          body: createReadableStream([
            harmonyDelta([
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "Search the docs." }],
              },
            ]),
            toolCallDelta(0, "call_1", "search_docs", ""),
            toolCallDelta(0, undefined, undefined, '{"query":"gateway port"}'),
            sseChunk("[DONE]"),
          ]),
        });
      }
      return Promise.resolve({
        ok: true,
        body: createReadableStream([
          harmonyDelta([
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "The tool says 8443." }],
            },
            { type: "text", text: "The default port is 8443." },
          ]),
          sseChunk("[DONE]"),
        ]),
      });
    });

    const adapter = createAdapter();
    const events: AgentEvent[] = [];

    for await (const event of adapter.run(
      { messages: createTestMessages(), tools: searchTools, threadId: "t1" },
      { executeTool },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledWith("search_docs", {
      query: "gateway port",
    });

    // The tool result must be present in the follow-up request the model sees.
    const [, secondInit] = (globalThis.fetch as any).mock.calls[1];
    const secondBody = JSON.parse(secondInit.body);
    const toolMessage = secondBody.messages.find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMessage.content).toContain("8443");

    // The array-shaped final answer is captured (not silently dropped).
    expect(events).toContainEqual({
      type: "message_delta",
      content: "The default port is 8443.",
    });
  });

  describe("Vertex/Gemini thoughtSignature pass-through", () => {
    // Vertex AI's OpenAI-compatible surface attaches `thoughtSignature`
    // on every function call emitted by Gemini 2.x/3.x models. The next
    // request must echo it back verbatim on the assistant message's
    // tool_calls or Vertex 400s with
    // `INVALID_ARGUMENT: function call X is missing a thought_signature`.

    function toolCallDeltaWithSig(opts: {
      index: number;
      id?: string;
      name?: string;
      args: string;
      /**
       * Vertex's on-the-wire spelling for Gemini 2.x/3.x function-calling
       * responses (camelCase, top-level on the tool_call). Verified
       * against `gemini-3.1-flash-lite-preview`.
       */
      sig?: string;
    }): string {
      return sseChunk(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: opts.index,
                    ...(opts.id && { id: opts.id }),
                    ...(opts.name && { type: "function" }),
                    function: {
                      ...(opts.name && { name: opts.name }),
                      arguments: opts.args,
                    },
                    ...(opts.sig && { thoughtSignature: opts.sig }),
                  },
                ],
              },
            },
          ],
        }),
      );
    }

    async function runUntilSecondRequest(chunks: string[]) {
      const executeTool = vi.fn().mockResolvedValue({ ok: true });
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            body: createReadableStream(chunks),
          });
        }
        return Promise.resolve({
          ok: true,
          body: createReadableStream([textDelta("done"), sseChunk("[DONE]")]),
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
      const [, secondInit] = (globalThis.fetch as any).mock.calls[1];
      return JSON.parse(secondInit.body);
    }

    test("captures camelCase thoughtSignature from delta and echoes it on outbound", async () => {
      // Real Vertex/Gemini wire shape, confirmed against
      // `gemini-3.1-flash-lite-preview`. The outbound request carries
      // back the same `thoughtSignature` Vertex sent, which is what the
      // proxy validates against on the next turn.
      const body = await runUntilSecondRequest([
        toolCallDeltaWithSig({
          index: 0,
          id: "call_1",
          name: "analytics__query",
          args: '{"query":"SELECT 1"}',
          sig: "sig-camel-abc123",
        }),
        sseChunk("[DONE]"),
      ]);
      expect(body.messages[1].tool_calls[0]).toEqual({
        id: "call_1",
        type: "function",
        function: {
          name: "analytics__query",
          arguments: '{"query":"SELECT 1"}',
        },
        thoughtSignature: "sig-camel-abc123",
      });
    });

    test("does NOT emit thoughtSignature when the model didn't send one", async () => {
      // Non-Gemini endpoints (Claude, OpenAI, Llama) don't carry the
      // field. Adapter must not invent one — that would break stricter
      // models' tool_call shape validators on Databricks.
      const body = await runUntilSecondRequest([
        toolCallDeltaWithSig({
          index: 0,
          id: "call_1",
          name: "analytics__query",
          args: '{"query":"SELECT 1"}',
        }),
        sseChunk("[DONE]"),
      ]);
      const tc = body.messages[1].tool_calls[0];
      expect(tc).not.toHaveProperty("thoughtSignature");
      expect(tc).not.toHaveProperty("thought_signature");
    });

    test("buildMessages echoes persisted thoughtSignature on resumed threads", async () => {
      // On thread resumption, the ToolCall.thoughtSignature stored in
      // ThreadStore must reach the wire so the very first request of
      // the new turn passes Vertex's signature check before any tool
      // call even fires.
      globalThis.fetch = mockFetch([textDelta("ok"), sseChunk("[DONE]")]);

      const adapter = createAdapter();
      const threadMessages: Message[] = [
        { id: "1", role: "user", content: "First", createdAt: new Date() },
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
              thoughtSignature: "persisted-sig-456",
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
        {
          id: "4",
          role: "user",
          content: "Now what?",
          createdAt: new Date(),
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
      expect(body.messages[1].tool_calls[0]).toEqual({
        id: "call_1",
        type: "function",
        function: {
          name: "analytics__query",
          arguments: JSON.stringify({ query: "SELECT 1" }),
        },
        thoughtSignature: "persisted-sig-456",
      });
    });
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

  test("forwards set generation params to the request body", async () => {
    globalThis.fetch = mockFetch([textDelta("Hi"), sseChunk("[DONE]")]);

    const adapter = createAdapter({
      generationParams: {
        temperature: 0.2,
        top_p: 0.9,
        stop: ["END"],
        frequency_penalty: 0.5,
        presence_penalty: 0.1,
      },
    });

    for await (const _ of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(["END"]);
    expect(body.frequency_penalty).toBe(0.5);
    expect(body.presence_penalty).toBe(0.1);
  });

  test("omits generation param keys that are not set", async () => {
    globalThis.fetch = mockFetch([textDelta("Hi"), sseChunk("[DONE]")]);

    const adapter = createAdapter({ generationParams: { temperature: 0.7 } });

    for await (const _ of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.temperature).toBe(0.7);
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("stop");
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body).not.toHaveProperty("presence_penalty");
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

    vi.mock("../../workspace-client", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../workspace-client")>();
      return {
        ...actual,
        createWorkspaceClient: vi.fn().mockImplementation(() => ({
          apiClient: { request: vi.fn() },
        })),
      };
    });

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

describe("DatabricksAdapter structured output", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockAuthenticate.mockClear();
  });

  interface FakeResponse {
    ok: boolean;
    status?: number;
    /** SSE chunks for the streaming path. */
    chunks?: string[];
    /** Parsed body for the non-streaming (structured) path. */
    json?: unknown;
    text?: string;
  }

  /** Records each request body and replays queued responses in order. */
  function capturingFetch(
    bodies: Array<Record<string, unknown>>,
    responses: FakeResponse[],
  ): typeof globalThis.fetch {
    let call = 0;
    return vi.fn().mockImplementation((_url, init) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      const r = responses[Math.min(call, responses.length - 1)];
      call++;
      return Promise.resolve({
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 400),
        body: r.ok ? createReadableStream(r.chunks ?? []) : null,
        json: () => Promise.resolve(r.json),
        text: () => Promise.resolve(r.text ?? ""),
      });
    });
  }

  /** A non-streaming chat-completion body with a single JSON message. */
  function completion(content: string): unknown {
    return { choices: [{ message: { role: "assistant", content } }] };
  }

  async function collect(
    gen: AsyncGenerator<AgentEvent>,
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const ev of gen) events.push(ev);
    return events;
  }

  const outputSchema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  };

  test("tool-free structured run is NON-streaming with response_format", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = capturingFetch(bodies, [
      { ok: true, json: completion('{"answer":"hi"}') },
    ]);

    const adapter = createAdapter();
    const events = await collect(
      adapter.run(
        {
          messages: createTestMessages(),
          tools: [],
          threadId: "t1",
          outputSchema,
        },
        { executeTool: vi.fn() },
      ),
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0].stream).toBe(false);
    expect(bodies[0].response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "structured_output",
        schema: outputSchema,
        strict: true,
      },
    });
    expect(bodies[0].tools).toBeUndefined();
    // The JSON arrives as a single `message` event (not streamed deltas).
    expect(events).toContainEqual({
      type: "message",
      content: '{"answer":"hi"}',
    });
  });

  test("does NOT send response_format when tools are present (stays streaming)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = capturingFetch(bodies, [
      { ok: true, chunks: [textDelta("done"), sseChunk("[DONE]")] },
    ]);

    const adapter = createAdapter();
    await collect(
      adapter.run(
        {
          messages: createTestMessages(),
          tools: createTestTools(),
          threadId: "t1",
          outputSchema,
        },
        { executeTool: vi.fn() },
      ),
    );

    expect(bodies[0].response_format).toBeUndefined();
    expect(bodies[0].tools).toBeDefined();
    expect(bodies[0].stream).toBe(true);
  });

  test("400 naming structured output strips response_format and retries once", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = capturingFetch(bodies, [
      {
        ok: false,
        status: 400,
        text: "INVALID_PARAMETER_VALUE: Structured output is not currently supported with streaming.",
      },
      { ok: true, json: completion('{"answer":"ok"}') },
    ]);

    const adapter = createAdapter();
    const events = await collect(
      adapter.run(
        {
          messages: createTestMessages(),
          tools: [],
          threadId: "t1",
          outputSchema,
        },
        { executeTool: vi.fn() },
      ),
    );

    // First body carried response_format; the retry stripped it. Both non-streaming.
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toBeDefined();
    expect(bodies[1].response_format).toBeUndefined();
    expect(events).toContainEqual({
      type: "message",
      content: '{"answer":"ok"}',
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "status", status: "error" }),
    );
  });

  test("a 400 NOT naming the param propagates (no strip-retry)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = capturingFetch(bodies, [
      { ok: false, status: 400, text: "Bad request: token limit exceeded" },
    ]);

    const adapter = createAdapter();
    await expect(
      collect(
        adapter.run(
          {
            messages: createTestMessages(),
            tools: [],
            threadId: "t1",
            outputSchema,
          },
          { executeTool: vi.fn() },
        ),
      ),
    ).rejects.toThrow(/token limit exceeded/);
    // Only the original request — no retry for an unrelated 400.
    expect(bodies).toHaveLength(1);
  });
});
