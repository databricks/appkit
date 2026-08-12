import type { AgentEvent, AgentToolDefinition, Message } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { consumeAdapterStream } from "../../core/agent/consume-adapter-stream";
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

function createTimedReadableStream(
  reads: Array<{
    at: number;
    chunk?: string;
    error?: Error;
    onRead?: () => void;
  }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          const next = reads[i++];
          if (!next) return { done: true, value: undefined };
          vi.setSystemTime(next.at);
          next.onRead?.();
          if (next.error) throw next.error;
          if (next.chunk === undefined) {
            return { done: true, value: undefined };
          }
          return { done: false, value: encoder.encode(next.chunk) };
        },
        async cancel() {},
        releaseLock() {},
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}

function completionChunk(options: {
  content?: string;
  toolCalls?: Array<Record<string, unknown>>;
  finishReason?: string;
  usage?: Record<string, unknown>;
  mlflowTraceId?: string;
  mlflowSpanId?: string;
  totalCostUsd?: number;
}): string {
  return sseChunk(
    JSON.stringify({
      choices: [
        {
          delta: {
            ...(options.content !== undefined
              ? { content: options.content }
              : {}),
            ...(options.toolCalls ? { tool_calls: options.toolCalls } : {}),
          },
          ...(options.finishReason
            ? { finish_reason: options.finishReason }
            : {}),
        },
      ],
      ...(options.usage ? { usage: options.usage } : {}),
      ...(options.mlflowTraceId
        ? { mlflow_trace_id: options.mlflowTraceId }
        : {}),
      ...(options.mlflowSpanId ? { mlflow_span_id: options.mlflowSpanId } : {}),
      ...(options.totalCostUsd !== undefined
        ? { total_cost_usd: options.totalCostUsd }
        : {}),
    }),
  );
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
    vi.useRealTimers();
  });

  test("emits an exact lifecycle pair for every streamed tool-loop model step", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    let request = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      request++;
      if (request === 1) {
        const body = createTimedReadableStream([
          {
            at: 1_010,
            chunk: completionChunk({
              toolCalls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "analytics__query",
                    arguments: '{"query":"SELECT 1"}',
                  },
                },
              ],
            }),
          },
          {
            at: 1_020,
            chunk: completionChunk({
              finishReason: "tool_calls",
              usage: {
                prompt_tokens: 20,
                completion_tokens: 5,
                total_tokens: 25,
                prompt_tokens_details: {
                  cached_tokens: 4,
                  cache_creation_tokens: 2,
                },
                cost_usd: 0.04,
              },
            }),
          },
          { at: 1_025 },
        ]);
        return {
          ok: true,
          body,
          headers: new Headers({
            "x-databricks-trace-id":
              "trace:/main.agent_traces.appkit/remote-step-1",
          }),
          text: () => Promise.resolve(""),
        };
      }

      return {
        ok: true,
        body: createTimedReadableStream([
          {
            at: 1_040,
            chunk: completionChunk({ content: "Final answer" }),
          },
          {
            at: 1_050,
            chunk: completionChunk({
              finishReason: "stop",
              usage: {
                input_tokens: 10,
                output_tokens: 7,
                total_tokens: 17,
                input_tokens_details: {
                  cached_tokens: 1,
                  cache_creation_tokens: 3,
                },
                cost: 0.03,
              },
            }),
          },
          { at: 1_055 },
        ]),
        headers: new Headers(),
        text: () => Promise.resolve(""),
      };
    });

    const events: AgentEvent[] = [];
    const adapter = createAdapter();
    for await (const event of adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool: vi.fn().mockResolvedValue([{ value: 1 }]) },
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "status",
      "model_start",
      "remote_trace",
      "model_end",
      "tool_call",
      "tool_result",
      "model_start",
      "message_delta",
      "model_end",
    ]);

    const starts = events.filter((event) => event.type === "model_start");
    const ends = events.filter((event) => event.type === "model_end");
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[0]).toEqual({
      type: "model_start",
      stepId: expect.any(String),
      model: "my-endpoint",
      provider: "databricks",
      input: {
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
        max_tokens: 4096,
        tools: [
          {
            type: "function",
            function: {
              name: "analytics__query",
              description: "Run SQL",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          },
        ],
      },
      startedAt: 1_000,
    });
    expect(starts[1]).toEqual({
      type: "model_start",
      stepId: expect.any(String),
      model: "my-endpoint",
      provider: "databricks",
      input: {
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "analytics__query",
                  arguments: '{"query":"SELECT 1"}',
                },
              },
            ],
          },
          {
            role: "tool",
            content: '[{"value":1}]',
            tool_call_id: "call_1",
          },
        ],
        stream: true,
        max_tokens: 4096,
        tools: expect.any(Array),
      },
      startedAt: 1_025,
    });
    expect(starts[0].stepId).not.toBe(starts[1].stepId);

    expect(ends[0]).toEqual({
      type: "model_end",
      stepId: starts[0].stepId,
      model: "my-endpoint",
      provider: "databricks",
      output: {
        text: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "analytics__query",
              arguments: '{"query":"SELECT 1"}',
            },
          },
        ],
      },
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 2,
        costUsd: 0.04,
        costAvailable: true,
      },
      finishReason: "tool_calls",
      firstTokenAt: 1_010,
      streamDurationMs: 25,
      endedAt: 1_025,
    });
    expect(ends[1]).toEqual({
      type: "model_end",
      stepId: starts[1].stepId,
      model: "my-endpoint",
      provider: "databricks",
      output: { text: "Final answer", toolCalls: [] },
      usage: {
        inputTokens: 10,
        outputTokens: 7,
        totalTokens: 17,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 3,
        costUsd: 0.03,
        costAvailable: true,
      },
      finishReason: "stop",
      firstTokenAt: 1_040,
      streamDurationMs: 30,
      endedAt: 1_055,
    });
    expect(events[2]).toEqual({
      type: "remote_trace",
      traceId: "trace:/main.agent_traces.appkit/remote-step-1",
      source: "model-serving",
      relation: "continued",
    });
  });

  test("preserves a final usage-only frame and marks an unpriced model unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createTimedReadableStream([
        {
          at: 2_015,
          chunk: completionChunk({
            finishReason: "stop",
            usage: {
              prompt_tokens: 8,
              completion_tokens: 2,
              total_tokens: 10,
            },
          }),
        },
        { at: 2_020 },
      ]),
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const adapter = createAdapter({
      endpointUrl:
        "https://test.databricks.com/serving-endpoints/unpriced-model/invocations",
    });
    const events: AgentEvent[] = [];
    for await (const event of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "status",
      "model_start",
      "model_end",
    ]);
    expect(events[2]).toEqual({
      type: "model_end",
      stepId: (events[1] as Extract<AgentEvent, { type: "model_start" }>)
        .stepId,
      model: "unpriced-model",
      provider: "databricks",
      output: { text: "", toolCalls: [] },
      usage: {
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        costAvailable: false,
      },
      finishReason: "stop",
      streamDurationMs: 20,
      endedAt: 2_020,
    });
    expect(events[2]).not.toHaveProperty("usage.costUsd");
    expect(events[2]).not.toHaveProperty("firstTokenAt");
  });

  test("applies a cost-only terminal frame without losing prior token usage", async () => {
    globalThis.fetch = mockFetch([
      completionChunk({
        content: "answer",
        finishReason: "stop",
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
        },
      }),
      sseChunk(
        JSON.stringify({
          choices: [],
          total_cost_usd: 0.123,
        }),
      ),
      sseChunk("[DONE]"),
    ]);

    const events: AgentEvent[] = [];
    for await (const event of createAdapter().run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "model_end")).toEqual(
      expect.objectContaining({
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          costUsd: 0.123,
          costAvailable: true,
        },
      }),
    );
  });

  test("maps top-level total_cost_usd when usage shares the terminal frame", async () => {
    globalThis.fetch = mockFetch([
      completionChunk({
        finishReason: "stop",
        usage: {
          prompt_tokens: 6,
          completion_tokens: 2,
          total_tokens: 8,
        },
        totalCostUsd: 0.456,
      }),
      sseChunk("[DONE]"),
    ]);

    const events: AgentEvent[] = [];
    for await (const event of createAdapter().run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "model_end")).toEqual(
      expect.objectContaining({
        usage: {
          inputTokens: 6,
          outputTokens: 2,
          totalTokens: 8,
          costUsd: 0.456,
          costAvailable: true,
        },
      }),
    );
  });

  test("emits a linked remote trace from a terminal MLflow trace event", async () => {
    globalThis.fetch = mockFetch([
      completionChunk({
        content: "ok",
        finishReason: "stop",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        mlflowTraceId: "trace:/catalog.schema.table/terminal-trace",
        mlflowSpanId: "0123456789abcdef",
      }),
    ]);

    const events: AgentEvent[] = [];
    for await (const event of createAdapter().run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "remote_trace",
      traceId: "trace:/catalog.schema.table/terminal-trace",
      spanId: "0123456789abcdef",
      source: "model-serving",
      relation: "linked",
    });
  });

  test("finalizes partial output and sanitized error when streaming throws", async () => {
    const adapter = new DatabricksAdapter({
      model: "failing-model",
      streamBody: async () =>
        createTimedReadableStream([
          { at: 3_010, chunk: textDelta("partial") },
          { at: 3_020, error: new Error("stream exploded\nwith details") },
        ]),
      maxSteps: 1,
    });

    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const events: AgentEvent[] = [];
    await expect(async () => {
      for await (const event of adapter.run(
        { messages: createTestMessages(), tools: [], threadId: "t1" },
        { executeTool: vi.fn() },
      )) {
        events.push(event);
      }
    }).rejects.toThrow("stream exploded");

    expect(events.map((event) => event.type)).toEqual([
      "status",
      "model_start",
      "message_delta",
      "status",
      "model_end",
    ]);
    const start = events[1] as Extract<AgentEvent, { type: "model_start" }>;
    expect(events[4]).toEqual({
      type: "model_end",
      stepId: start.stepId,
      model: "failing-model",
      provider: "databricks",
      output: { text: "partial", toolCalls: [] },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costAvailable: false,
      },
      firstTokenAt: 3_010,
      streamDurationMs: 20,
      endedAt: 3_020,
      error: "stream exploded with details",
    });
  });

  test("finalizes partial output when the model stream is cancelled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const controller = new AbortController();
    const adapter = new DatabricksAdapter({
      model: "cancelled-model",
      streamBody: async () =>
        createTimedReadableStream([
          { at: 4_010, chunk: textDelta("partial") },
          { at: 4_020, chunk: textDelta("ignored") },
        ]),
      maxSteps: 1,
    });
    const events: AgentEvent[] = [];
    for await (const event of adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn(), signal: controller.signal },
    )) {
      events.push(event);
      if (event.type === "message_delta") controller.abort();
    }

    expect(events.map((event) => event.type)).toEqual([
      "status",
      "model_start",
      "message_delta",
      "model_end",
    ]);
    expect(events[3]).toEqual(
      expect.objectContaining({
        type: "model_end",
        stepId: (events[1] as Extract<AgentEvent, { type: "model_start" }>)
          .stepId,
        model: "cancelled-model",
        output: { text: "partial", toolCalls: [] },
        finishReason: "cancelled",
        firstTokenAt: 4_010,
        streamDurationMs: 10,
        endedAt: 4_010,
      }),
    );
    expect(events[3]).not.toHaveProperty("error");
  });

  test("drains buffered deltas through model_end after cancellation without exposing them", async () => {
    const controller = new AbortController();
    globalThis.fetch = mockFetch([
      textDelta("visible") +
        textDelta("suppressed") +
        completionChunk({
          finishReason: "stop",
          usage: {
            input_tokens: 9,
            output_tokens: 3,
            total_tokens: 12,
          },
          mlflowTraceId: "trace:/catalog.schema.table/cancelled-remote",
          mlflowSpanId: "0123456789abcdef",
        }) +
        sseChunk("[DONE]"),
    ]);
    const seen: AgentEvent[] = [];

    const result = await consumeAdapterStream(
      createAdapter().run(
        { messages: createTestMessages(), tools: [], threadId: "t1" },
        { executeTool: vi.fn(), signal: controller.signal },
      ),
      {
        signal: controller.signal,
        onEvent(event) {
          seen.push(event);
          if (event.type === "message_delta") controller.abort();
        },
      },
    );

    expect(seen.map((event) => event.type)).toEqual([
      "status",
      "model_start",
      "message_delta",
      "remote_trace",
      "model_end",
    ]);
    expect(result).toEqual({
      text: "visible",
      usage: {
        inputTokens: 9,
        outputTokens: 3,
        totalTokens: 12,
        costAvailable: false,
      },
      remoteTrace: {
        type: "remote_trace",
        traceId: "trace:/catalog.schema.table/cancelled-remote",
        spanId: "0123456789abcdef",
        source: "model-serving",
        relation: "linked",
      },
    });
  });

  test("retains empty tool arguments when streaming fails after the tool name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_000);
    const adapter = new DatabricksAdapter({
      model: "partial-tool-model",
      streamBody: async () =>
        createTimedReadableStream([
          {
            at: 6_010,
            chunk: toolCallDelta(0, "call_partial", "analytics__query", ""),
          },
          { at: 6_020, error: new Error("stream failed") },
        ]),
      maxSteps: 1,
    });
    const events: AgentEvent[] = [];

    await expect(async () => {
      for await (const event of adapter.run(
        {
          messages: createTestMessages(),
          tools: createTestTools(),
          threadId: "t1",
        },
        { executeTool: vi.fn() },
      )) {
        events.push(event);
      }
    }).rejects.toThrow("stream failed");

    expect(events.find((event) => event.type === "model_end")).toEqual(
      expect.objectContaining({
        output: {
          text: "",
          toolCalls: [
            {
              id: "call_partial",
              type: "function",
              function: {
                name: "analytics__query",
                arguments: "",
              },
            },
          ],
        },
        error: "stream failed",
      }),
    );
  });

  test("retains empty tool arguments when cancelled after the tool name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(7_000);
    const controller = new AbortController();
    const adapter = new DatabricksAdapter({
      model: "cancelled-tool-model",
      streamBody: async () =>
        createTimedReadableStream([
          {
            at: 7_010,
            chunk: toolCallDelta(0, "call_partial", "analytics__query", ""),
            onRead: () => controller.abort(),
          },
          { at: 7_020 },
        ]),
      maxSteps: 1,
    });
    const events: AgentEvent[] = [];

    for await (const event of adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      { executeTool: vi.fn(), signal: controller.signal },
    )) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "model_end")).toEqual(
      expect.objectContaining({
        output: {
          text: "",
          toolCalls: [
            {
              id: "call_partial",
              type: "function",
              function: {
                name: "analytics__query",
                arguments: "",
              },
            },
          ],
        },
        finishReason: "cancelled",
      }),
    );
  });

  test("finalizes a model step when iteration stops immediately after model_start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const adapter = new DatabricksAdapter({
      model: "early-cancel-model",
      streamBody: async () => createReadableStream([]),
      maxSteps: 1,
    });
    const iterator = adapter.run(
      { messages: createTestMessages(), tools: [], threadId: "t1" },
      { executeTool: vi.fn() },
    );

    expect((await iterator.next()).value).toEqual({
      type: "status",
      status: "running",
    });
    const started = await iterator.next();
    expect(started.value).toEqual(
      expect.objectContaining({
        type: "model_start",
        model: "early-cancel-model",
        startedAt: 5_000,
      }),
    );

    const finalized = await iterator.return();
    expect(finalized).toEqual({
      done: false,
      value: {
        type: "model_end",
        stepId: (started.value as Extract<AgentEvent, { type: "model_start" }>)
          .stepId,
        model: "early-cancel-model",
        provider: "databricks",
        output: { text: "", toolCalls: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costAvailable: false,
        },
        streamDurationMs: 0,
        endedAt: 5_000,
      },
    });
    await iterator.return();
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
    expect(events[1]).toEqual(
      expect.objectContaining({ type: "model_start", model: "my-endpoint" }),
    );
    expect(events[2]).toEqual({ type: "message_delta", content: "Hello" });
    expect(events[3]).toEqual({ type: "message_delta", content: " world" });
    expect(events[4]).toEqual(
      expect.objectContaining({
        type: "model_end",
        stepId: (events[1] as Extract<AgentEvent, { type: "model_start" }>)
          .stepId,
        output: { text: "Hello world", toolCalls: [] },
      }),
    );
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

  test("omits the raw response body from non-ok transport errors", async () => {
    const secretValues = [
      "bearer-secret",
      "authorization-secret",
      "cookie-secret",
      "api-key-secret",
      "password-secret",
      "credential-secret",
      "url-token-secret",
      "url-api-key-secret",
      "url-password-secret",
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () =>
        Promise.resolve(
          "Unauthorized " +
            "Bearer bearer-secret " +
            "Authorization: Basic authorization-secret " +
            "Cookie: session=cookie-secret " +
            "X-API-Key: api-key-secret " +
            "password=password-secret " +
            "credentials=credential-secret " +
            "https://example.test/path?token=url-token-secret&api_key=url-api-key-secret&password=url-password-secret",
        ),
    });

    const adapter = createAdapter();
    const events: AgentEvent[] = [];

    await expect(async () => {
      for await (const event of adapter.run(
        { messages: createTestMessages(), tools: [], threadId: "t1" },
        { executeTool: vi.fn() },
      )) {
        events.push(event);
      }
    }).rejects.toThrow(/^Databricks API error \(401\)$/);

    const modelEnd = events.find((event) => event.type === "model_end");
    expect(modelEnd).toEqual(
      expect.objectContaining({ error: "Databricks API error (401)" }),
    );
    for (const secret of secretValues) {
      expect(
        (modelEnd as Extract<AgentEvent, { type: "model_end" }>).error,
      ).not.toContain(secret);
    }
  });

  test("redacts secret-bearing patterns from other lifecycle errors", async () => {
    const secretValues = [
      "bearer-secret",
      "authorization-secret",
      "cookie-one-secret",
      "cookie-two-secret",
      "set-cookie-one-secret",
      "set-cookie-two-secret",
      "api-key-secret",
      "password-secret",
      "credential-secret",
      "url-token-secret",
      "url-api-key-secret",
      "url-password-secret",
      "http-url-secret",
    ];
    const adapter = new DatabricksAdapter({
      model: "secret-error-model",
      streamBody: async () => {
        throw new Error(
          "failed\n" +
            "Bearer bearer-secret\n" +
            "Authorization: Basic authorization-secret\n" +
            "Cookie: first=cookie-one-secret; second=cookie-two-secret; theme=public\n" +
            "Set-Cookie: session=set-cookie-one-secret; Path=/; preference=set-cookie-two-secret; Secure\n" +
            "X-API-Key: api-key-secret\n" +
            "password=password-secret\n" +
            "credentials=credential-secret\n" +
            "https://example.test/path?token=url-token-secret&api_key=url-api-key-secret&password=url-password-secret\n" +
            "http://insecure.test/path?secret=http-url-secret",
        );
      },
      maxSteps: 1,
    });
    const events: AgentEvent[] = [];

    await expect(async () => {
      for await (const event of adapter.run(
        { messages: createTestMessages(), tools: [], threadId: "t1" },
        { executeTool: vi.fn() },
      )) {
        events.push(event);
      }
    }).rejects.toThrow("bearer-secret");

    const error = (
      events.find(
        (event): event is Extract<AgentEvent, { type: "model_end" }> =>
          event.type === "model_end",
      ) as Extract<AgentEvent, { type: "model_end" }>
    ).error;
    expect(error).toContain("[REDACTED]");
    expect(error?.length).toBeLessThanOrEqual(512);
    expect(error).not.toContain("\n");
    expect(error).not.toMatch(/https?:\/\//);
    expect(error).not.toContain("theme=public");
    expect(error).not.toContain("Path=/");
    expect(error).not.toContain("Secure");
    for (const secret of secretValues) expect(error).not.toContain(secret);
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
    expect(events[1]).toEqual(expect.objectContaining({ type: "model_start" }));
    expect(events[2]).toEqual({
      type: "status",
      status: "error",
      error: "serving_unreachable",
    });
    expect(events[3]).toEqual(
      expect.objectContaining({
        type: "model_end",
        stepId: (events[1] as Extract<AgentEvent, { type: "model_start" }>)
          .stepId,
        error: "serving_unreachable",
      }),
    );
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
