import type { AgentEvent, AgentInput } from "shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fromSupervisorApi,
  SupervisorApiAdapter,
  type SupervisorTool,
  supervisorTools,
} from "../supervisor-api";

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

function sseEvent(eventName: string, data: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Captures the body the adapter posts and returns a fake stream of SSE
 * chunks. Mirrors the `streamBody` test pattern used by `DatabricksAdapter`.
 */
function makeStreamBody(chunks: string[]): {
  streamBody: ReturnType<typeof vi.fn>;
  lastBody: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const streamBody = vi.fn(async (body: Record<string, unknown>) => {
    captured = body;
    return createReadableStream(chunks);
  });
  return { streamBody, lastBody: () => captured };
}

function createInput(): AgentInput {
  return {
    messages: [
      { id: "1", role: "user", content: "Hello", createdAt: new Date() },
    ],
    tools: [],
    threadId: "thread-1",
  };
}

async function collect(
  gen: AsyncGenerator<AgentEvent, void, unknown>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("supervisorTools factories", () => {
  test("genieSpace produces correct wire shape", () => {
    expect(supervisorTools.genieSpace("space123", "NYC taxi data")).toEqual({
      type: "genie_space",
      genie_space: { id: "space123", description: "NYC taxi data" },
    });
  });

  test("ucFunction produces correct wire shape", () => {
    expect(
      supervisorTools.ucFunction("main.default.add", "Adds two integers."),
    ).toEqual({
      type: "uc_function",
      uc_function: {
        name: "main.default.add",
        description: "Adds two integers.",
      },
    });
  });

  test("knowledgeAssistant maps id into knowledge_assistant_id", () => {
    expect(
      supervisorTools.knowledgeAssistant("ka-1", "Internal docs Q&A"),
    ).toEqual({
      type: "knowledge_assistant",
      knowledge_assistant: {
        knowledge_assistant_id: "ka-1",
        description: "Internal docs Q&A",
      },
    });
  });

  test("app produces correct wire shape", () => {
    expect(supervisorTools.app("my-app", "Demo Databricks app.")).toEqual({
      type: "app",
      app: { name: "my-app", description: "Demo Databricks app." },
    });
  });

  test("ucConnection produces correct wire shape", () => {
    expect(
      supervisorTools.ucConnection("my-conn", "Connection to external DB."),
    ).toEqual({
      type: "uc_connection",
      uc_connection: {
        name: "my-conn",
        description: "Connection to external DB.",
      },
    });
  });
});

describe("SupervisorApiAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("posts model, input, tools, and stream:true through streamBody", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.output_text.delta", { delta: "Hi" }),
      sseEvent("response.completed", {}),
    ]);

    const tools: SupervisorTool[] = [
      supervisorTools.genieSpace("g1", "Test genie space"),
    ];
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
      tools,
    });

    await collect(adapter.run(createInput(), { executeTool: vi.fn() }));

    expect(streamBody).toHaveBeenCalledTimes(1);
    expect(lastBody()).toMatchObject({
      model: "databricks-claude-sonnet-4",
      input: "Hello",
      stream: true,
      tools,
    });
  });

  test("omits the tools field entirely when no tools are configured", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    await collect(adapter.run(createInput(), { executeTool: vi.fn() }));
    expect(lastBody()).not.toHaveProperty("tools");
  });

  test("hoists system messages into the top-level instructions field", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    await collect(
      adapter.run(
        {
          messages: [
            {
              id: "s",
              role: "system",
              content: "Be terse.",
              createdAt: new Date(),
            },
            { id: "u", role: "user", content: "Hi", createdAt: new Date() },
          ],
          tools: [],
          threadId: "t",
        },
        { executeTool: vi.fn() },
      ),
    );
    const body = lastBody();
    expect(body?.instructions).toBe("Be terse.");
    expect(body?.input).toBe("Hi");
  });

  test("omits instructions when there is no system message", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    await collect(adapter.run(createInput(), { executeTool: vi.fn() }));
    expect(lastBody()).not.toHaveProperty("instructions");
  });

  test("emits message_delta and complete on the happy path", async () => {
    const { streamBody } = makeStreamBody([
      sseEvent("response.output_text.delta", { delta: "Hello" }),
      sseEvent("response.output_text.delta", { delta: " world" }),
      sseEvent("response.completed", {}),
    ]);

    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );

    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "message_delta", content: "Hello" },
      { type: "message_delta", content: " world" },
      { type: "status", status: "complete" },
    ]);
  });

  test("maps response.failed to a status:error event", async () => {
    const { streamBody } = makeStreamBody([sseEvent("response.failed", {})]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toContainEqual({
      type: "status",
      status: "error",
      error: "Response failed",
    });
  });

  test("maps top-level error events", async () => {
    const { streamBody } = makeStreamBody([
      sseEvent("error", { error: "rate limited" }),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toContainEqual({
      type: "status",
      status: "error",
      error: "rate limited",
    });
  });

  test("maps response.output_item.done with id:'error' to status:error", async () => {
    const { streamBody } = makeStreamBody([
      sseEvent("response.output_item.done", {
        item: {
          id: "error",
          content: [{ text: "Tool execution failed" }],
        },
      }),
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toContainEqual({
      type: "status",
      status: "error",
      error: "Tool execution failed",
    });
  });

  test("falls back to output_item.done text when no deltas streamed (tool-driven SA response)", async () => {
    const { streamBody } = makeStreamBody([
      sseEvent("response.output_item.added", {
        item: { type: "message", id: "msg-1", role: "assistant", content: [] },
      }),
      sseEvent("response.output_item.done", {
        item: {
          type: "message",
          id: "msg-1",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Genie says hi." }],
        },
      }),
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "message_delta", content: "Genie says hi." },
      { type: "status", status: "complete" },
    ]);
  });

  test("does not double-emit when both deltas and output_item.done arrive for the same item", async () => {
    const { streamBody } = makeStreamBody([
      sseEvent("response.output_text.delta", {
        item_id: "msg-1",
        delta: "Hello",
      }),
      sseEvent("response.output_text.delta", {
        item_id: "msg-1",
        delta: " world",
      }),
      sseEvent("response.output_item.done", {
        item: {
          type: "message",
          id: "msg-1",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello world" }],
        },
      }),
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "message_delta", content: "Hello" },
      { type: "message_delta", content: " world" },
      { type: "status", status: "complete" },
    ]);
  });

  test("emits status:error when the underlying streamBody throws", async () => {
    const streamBody = vi
      .fn()
      .mockRejectedValue(new Error("Supervisor API error (500): boom"));
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toContainEqual({
      type: "status",
      status: "error",
      error: "Supervisor API error: Supervisor API error (500): boom",
    });
  });

  test("short-circuits when the signal is already aborted", async () => {
    const streamBody = vi.fn();
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });

    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      adapter.run(createInput(), {
        executeTool: vi.fn(),
        signal: controller.signal,
      }),
    );

    expect(events).toEqual([]);
    expect(streamBody).not.toHaveBeenCalled();
  });

  test("multi-turn input (user + assistant + user) is sent as a structured array", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });

    await collect(
      adapter.run(
        {
          messages: [
            { id: "u1", role: "user", content: "Hi", createdAt: new Date() },
            {
              id: "a",
              role: "assistant",
              content: "Hello!",
              createdAt: new Date(),
            },
            {
              id: "u2",
              role: "user",
              content: "Tell me more",
              createdAt: new Date(),
            },
          ],
          tools: [],
          threadId: "t",
        },
        { executeTool: vi.fn() },
      ),
    );

    expect(lastBody()?.input).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Tell me more" },
    ]);
  });

  test("drops tool-role messages from the request payload", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    await collect(
      adapter.run(
        {
          messages: [
            { id: "u", role: "user", content: "Hi", createdAt: new Date() },
            {
              id: "t1",
              role: "tool",
              content: "(genie result)",
              createdAt: new Date(),
            },
          ],
          tools: [],
          threadId: "t",
        },
        { executeTool: vi.fn() },
      ),
    );
    expect(lastBody()?.input).toBe("Hi");
  });

  test("recovers final assistant text from response.completed.output when no deltas streamed", async () => {
    // Real-world flake: SA occasionally finishes a turn with zero
    // `output_text.delta` events and no `output_item.done` for the message,
    // but still mirrors the full assistant text in `response.completed`.
    // Without recovery the UI sees a silent empty turn.
    const { streamBody } = makeStreamBody([
      sseEvent("response.created", {}),
      sseEvent("response.in_progress", {}),
      sseEvent("response.completed", {
        response: {
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg-x",
              role: "assistant",
              content: [
                { type: "output_text", text: "Recovered " },
                { type: "output_text", text: "answer." },
              ],
            },
          ],
        },
      }),
    ]);

    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );

    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "message_delta", content: "Recovered answer." },
      { type: "status", status: "complete" },
    ]);
  });

  test("does not recover from response.completed when deltas already streamed", async () => {
    const { streamBody } = makeStreamBody([
      sseEvent("response.output_text.delta", {
        item_id: "msg-x",
        delta: "Hi",
      }),
      sseEvent("response.completed", {
        response: {
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg-x",
              role: "assistant",
              content: [{ type: "output_text", text: "Hi" }],
            },
          ],
        },
      }),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    const deltas = events.filter((e) => e.type === "message_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual({ type: "message_delta", content: "Hi" });
  });

  test("treats response.failed as terminal: no events follow the error", async () => {
    // SA may keep sending events after `response.failed` (and even a stray
    // `response.completed`). The adapter must stop yielding once it has
    // surfaced a terminal `status: error` so consumers don't see contradictory
    // `message_delta`/`complete` events after the failure.
    const { streamBody } = makeStreamBody([
      sseEvent("response.failed", {}),
      sseEvent("response.output_text.delta", { delta: "ignored" }),
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "status", status: "error", error: "Response failed" },
    ]);
  });

  test("does not yield complete when the consumer aborts mid-stream", async () => {
    // Stream that yields one delta, then waits forever — the consumer aborts
    // after the first event arrives. The adapter must NOT subsequently yield
    // a synthesised `complete` from a buffered `response.completed`.
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          encoder.encode(
            sseEvent("response.output_text.delta", { delta: "Hi" }),
          ),
        );
      },
      pull() {
        return new Promise<void>(() => {
          /* never resolves until cancel() */
        });
      },
    });

    const adapter = new SupervisorApiAdapter({
      streamBody: async () => stream,
      model: "databricks-claude-sonnet-4",
    });

    const events: AgentEvent[] = [];
    for await (const e of adapter.run(createInput(), {
      executeTool: vi.fn(),
      signal: controller.signal,
    })) {
      events.push(e);
      if (e.type === "message_delta") controller.abort();
    }

    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "message_delta", content: "Hi" },
    ]);
  });

  test("recovers when event: and data: lines arrive in separate chunks", async () => {
    const { streamBody } = makeStreamBody([
      "event: response.output_text.delta\n",
      `data: ${JSON.stringify({ delta: "split" })}\n\n`,
      "event: response.completed\ndata: {}\n\n",
    ]);

    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toContainEqual({
      type: "message_delta",
      content: "split",
    });
    expect(events).toContainEqual({ type: "status", status: "complete" });
  });
});

describe("fromSupervisorApi", () => {
  test("calls ensureResolved on the supplied workspace client", async () => {
    const ensureResolved = vi.fn(async () => {});
    const adapter = await fromSupervisorApi({
      model: "databricks-claude-sonnet-4",
      workspaceClient: {
        config: { ensureResolved },
        apiClient: { request: vi.fn() },
      },
    });
    expect(ensureResolved).toHaveBeenCalledTimes(1);
    expect(adapter).toBeInstanceOf(SupervisorApiAdapter);
  });

  test("routes streaming through apiClient.request with the SA path", async () => {
    const encoder = new TextEncoder();
    const contents = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent("response.completed", {})));
        controller.close();
      },
    });
    const request = vi.fn().mockResolvedValue({ contents });

    const adapter = await fromSupervisorApi({
      model: "databricks-claude-sonnet-4",
      workspaceClient: {
        config: { ensureResolved: vi.fn(async () => {}) },
        apiClient: { request },
      },
    });

    await collect(adapter.run(createInput(), { executeTool: vi.fn() }));

    expect(request).toHaveBeenCalledTimes(1);
    const [requestArgs] = request.mock.calls[0];
    expect(requestArgs.path).toBe("/ai-gateway/mlflow/v1/responses");
    expect(requestArgs.method).toBe("POST");
    expect(requestArgs.raw).toBe(true);
    expect(requestArgs.payload).toMatchObject({
      model: "databricks-claude-sonnet-4",
      input: "Hello",
      stream: true,
    });
    expect(requestArgs.payload).not.toHaveProperty("tools");
  });
});
