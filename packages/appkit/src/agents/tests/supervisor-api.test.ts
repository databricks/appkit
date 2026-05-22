import type { AgentEvent, AgentInput } from "shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fromSupervisorApi,
  isSupervisorTool,
  SUPERVISOR_EXTENSION_KEY,
  SupervisorApiAdapter,
  type SupervisorExtension,
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

function createInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    messages: [
      { id: "1", role: "user", content: "Hello", createdAt: new Date() },
    ],
    tools: [],
    threadId: "thread-1",
    ...overrides,
  };
}

/**
 * Convenience to build the `extensions` payload the agents plugin / runAgent
 * produce, so tests don't have to repeat the key/shape boilerplate.
 */
function withSupervisorTools(
  hostedTools: SupervisorTool[],
): Pick<AgentInput, "extensions"> {
  const ext: SupervisorExtension = { hostedTools };
  return { extensions: { [SUPERVISOR_EXTENSION_KEY]: ext } };
}

async function collect(
  gen: AsyncGenerator<AgentEvent, void, unknown>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("supervisorTools factories", () => {
  test("genieSpace returns a tagged record wrapping the wire spec", () => {
    const tool = supervisorTools.genieSpace({
      id: "space123",
      description: "NYC taxi data",
    });
    expect(tool).toEqual({
      __kind: "hosted-supervisor",
      spec: {
        type: "genie_space",
        genie_space: { id: "space123", description: "NYC taxi data" },
      },
    });
  });

  test("ucFunction returns a tagged record wrapping the wire spec", () => {
    const tool = supervisorTools.ucFunction({
      name: "main.default.add",
      description: "Adds two integers.",
    });
    expect(tool).toEqual({
      __kind: "hosted-supervisor",
      spec: {
        type: "uc_function",
        uc_function: {
          name: "main.default.add",
          description: "Adds two integers.",
        },
      },
    });
  });

  test("knowledgeAssistant maps knowledgeAssistantId into the wire field", () => {
    const tool = supervisorTools.knowledgeAssistant({
      knowledgeAssistantId: "ka-1",
      description: "Internal docs Q&A",
    });
    expect(tool).toEqual({
      __kind: "hosted-supervisor",
      spec: {
        type: "knowledge_assistant",
        knowledge_assistant: {
          knowledge_assistant_id: "ka-1",
          description: "Internal docs Q&A",
        },
      },
    });
  });

  test("app returns a tagged record wrapping the wire spec", () => {
    const tool = supervisorTools.app({
      name: "my-app",
      description: "Demo Databricks app.",
    });
    expect(tool).toEqual({
      __kind: "hosted-supervisor",
      spec: {
        type: "app",
        app: { name: "my-app", description: "Demo Databricks app." },
      },
    });
  });

  test("ucConnection returns a tagged record wrapping the wire spec", () => {
    const tool = supervisorTools.ucConnection({
      name: "my-conn",
      description: "Connection to external DB.",
    });
    expect(tool).toEqual({
      __kind: "hosted-supervisor",
      spec: {
        type: "uc_connection",
        uc_connection: {
          name: "my-conn",
          description: "Connection to external DB.",
        },
      },
    });
  });
});

describe("isSupervisorTool", () => {
  test("accepts every supervisorTools.* factory output", () => {
    expect(
      isSupervisorTool(
        supervisorTools.genieSpace({ id: "g", description: "d" }),
      ),
    ).toBe(true);
    expect(
      isSupervisorTool(
        supervisorTools.ucFunction({ name: "main.x.y", description: "d" }),
      ),
    ).toBe(true);
    expect(
      isSupervisorTool(
        supervisorTools.knowledgeAssistant({
          knowledgeAssistantId: "ka",
          description: "d",
        }),
      ),
    ).toBe(true);
    expect(
      isSupervisorTool(supervisorTools.app({ name: "a", description: "d" })),
    ).toBe(true);
    expect(
      isSupervisorTool(
        supervisorTools.ucConnection({ name: "c", description: "d" }),
      ),
    ).toBe(true);
  });

  test("rejects plain wire-format objects (no __kind tag)", () => {
    const wireOnly: SupervisorTool = {
      type: "genie_space",
      genie_space: { id: "g", description: "d" },
    };
    expect(isSupervisorTool(wireOnly)).toBe(false);
  });

  test("rejects MCP hosted tools and other shapes", () => {
    expect(isSupervisorTool({ type: "genie-space", genie_space: {} })).toBe(
      false,
    );
    expect(isSupervisorTool(null)).toBe(false);
    expect(isSupervisorTool(undefined)).toBe(false);
    expect(isSupervisorTool("hosted-supervisor")).toBe(false);
    expect(isSupervisorTool({})).toBe(false);
    expect(isSupervisorTool({ __kind: "function" })).toBe(false);
  });
});

describe("SupervisorApiAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("declares capability negotiation fields (acceptsExtensions, consumesInputTools)", () => {
    const adapter = new SupervisorApiAdapter({
      streamBody: vi.fn(),
      model: "databricks-claude-sonnet-4",
    });
    expect(adapter.acceptsExtensions).toEqual([SUPERVISOR_EXTENSION_KEY]);
    expect(adapter.consumesInputTools).toBe(false);
  });

  test("posts model, input, and stream:true through streamBody", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.output_text.delta", { delta: "Hi" }),
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });

    await collect(adapter.run(createInput(), { executeTool: vi.fn() }));

    expect(streamBody).toHaveBeenCalledTimes(1);
    expect(lastBody()).toMatchObject({
      model: "databricks-claude-sonnet-4",
      input: "Hello",
      stream: true,
    });
    // No tools wired via extensions -> no `tools` field on the wire.
    expect(lastBody()).not.toHaveProperty("tools");
  });

  test("reads hosted tools from AgentInput.extensions and posts them in the request body", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });

    const genie = supervisorTools.genieSpace({
      id: "g1",
      description: "Test genie space",
    });
    const uc = supervisorTools.ucFunction({
      name: "main.x.add",
      description: "Adds two integers.",
    });

    await collect(
      adapter.run(createInput(withSupervisorTools([genie.spec, uc.spec])), {
        executeTool: vi.fn(),
      }),
    );

    expect(lastBody()?.tools).toEqual([genie.spec, uc.spec]);
  });

  test("ignores extensions written under a different key (key namespacing)", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });

    await collect(
      adapter.run(
        createInput({
          extensions: {
            "other.namespace": { hostedTools: [{ type: "ignored" }] },
          },
        }),
        { executeTool: vi.fn() },
      ),
    );

    expect(lastBody()).not.toHaveProperty("tools");
  });

  test("omits the tools field entirely when extensions carry an empty hostedTools array", async () => {
    const { streamBody, lastBody } = makeStreamBody([
      sseEvent("response.completed", {}),
    ]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    await collect(
      adapter.run(createInput(withSupervisorTools([])), {
        executeTool: vi.fn(),
      }),
    );
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

  test("maps response.failed to a sanitised status:error event", async () => {
    // The verbose upstream payload must NOT reach the client (CWE-209) —
    // only the stable `upstream_failed` code does. Server logs still keep
    // the full detail via logger.warn.
    const { streamBody } = makeStreamBody([
      sseEvent("response.failed", {
        response: { error: { message: "secret-internal-stack-trace" } },
      }),
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
      error: "Supervisor API error (upstream_failed)",
    });
    // Belt-and-braces: the leaky upstream string is never in the event.
    for (const e of events) {
      if (e.type === "status" && "error" in e) {
        expect(e.error).not.toContain("secret-internal-stack-trace");
      }
    }
  });

  test("maps top-level error events to sanitised upstream_unknown code", async () => {
    const { streamBody } = makeStreamBody([
      sseEvent("error", { error: "rate limited (workspace abc-123)" }),
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
      error: "Supervisor API error (upstream_unknown)",
    });
    for (const e of events) {
      if (e.type === "status" && "error" in e) {
        expect(e.error).not.toContain("workspace abc-123");
      }
    }
  });

  test("maps response.output_item.done error item to sanitised upstream_tool code", async () => {
    const { streamBody } = makeStreamBody([
      sseEvent("response.output_item.done", {
        item: {
          id: "error",
          type: "error",
          content: [{ text: "Tool stack trace with /home/user paths" }],
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
      error: "Supervisor API error (upstream_tool)",
    });
    for (const e of events) {
      if (e.type === "status" && "error" in e) {
        expect(e.error).not.toContain("/home/user");
      }
    }
  });

  test("does NOT treat output_item.done id:'error' as error when type:'message' (collision guard)", async () => {
    // SA reserves `id === "error"` for tool failures, but the 5-char id
    // could collide with a legitimately-id'd assistant message. The guard
    // requires `type === "error"` (or a non-message type alongside the
    // reserved id) so a stray message with id="error" is not mis-classified.
    const { streamBody } = makeStreamBody([
      sseEvent("response.output_item.done", {
        item: {
          id: "error",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello from error-id msg" }],
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
      { type: "message_delta", content: "hello from error-id msg" },
      { type: "status", status: "complete" },
    ]);
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

  test("emits sanitised transport error when the underlying streamBody throws", async () => {
    const streamBody = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "HTTP 500 from https://workspace-internal.foo: stack trace ...",
        ),
      );
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
      error: "Supervisor API error (transport)",
    });
    for (const e of events) {
      if (e.type === "status" && "error" in e) {
        expect(e.error).not.toContain("workspace-internal.foo");
        expect(e.error).not.toContain("stack trace");
      }
    }
  });

  test("does NOT emit a terminal error when the consumer aborts before streamBody resolves", async () => {
    // Regression: previously the streamBody catch yielded a sanitised
    // `{status:"error"}` even when the underlying rejection was an abort
    // triggered by the consumer. Consumers that issued the abort must see
    // a clean stop (zero further events after their abort), not a
    // contradictory terminal error.
    const controller = new AbortController();
    const streamBody = vi.fn(async (_body, signal?: AbortSignal) => {
      controller.abort();
      // Simulate the SDK transport rejecting because the signal aborted.
      // The catch path must observe `signal.aborted` and return silently.
      throw new DOMException(
        signal?.aborted ? "aborted" : "fetch failed",
        "AbortError",
      );
    });

    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), {
        executeTool: vi.fn(),
        signal: controller.signal,
      }),
    );

    expect(events).toEqual([{ type: "status", status: "running" }]);
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
      {
        type: "status",
        status: "error",
        error: "Supervisor API error (upstream_failed)",
      },
    ]);
  });

  test("does NOT yield complete when response.completed carries status:'failed'", async () => {
    // Regression for the silent-success-on-failure bug: SA occasionally
    // reports a failed turn via `response.completed.status = "failed"`
    // (with optional `error`/`incomplete_details`) rather than emitting
    // `response.failed`. The adapter must surface this as a terminal
    // error and NOT yield `{status:"complete"}`.
    const { streamBody } = makeStreamBody([
      sseEvent("response.completed", {
        response: {
          status: "failed",
          error: { message: "tool timeout" },
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
      {
        type: "status",
        status: "error",
        error: "Supervisor API error (upstream_failed)",
      },
    ]);
  });

  test("does NOT yield complete when response.completed carries a populated error", async () => {
    // Variant: status reported as "completed" but `error` is non-null.
    // Treat as a terminal failure rather than silently completing.
    const { streamBody } = makeStreamBody([
      sseEvent("response.completed", {
        response: {
          status: "completed",
          error: { code: "internal" },
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
    expect(events).toContainEqual({
      type: "status",
      status: "error",
      error: "Supervisor API error (upstream_failed)",
    });
    expect(events).not.toContainEqual({
      type: "status",
      status: "complete",
    });
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

  test("yields a sanitised transport error when readSseEvents throws mid-stream", async () => {
    // `readSseEvents` enforces a DoS cap (maxLineChars) and throws when an
    // SSE block exceeds it. Without a try/catch around the consuming loop
    // that rejection would propagate out of run() and tear down the request.
    // The adapter must catch it and surface a terminal `transport` error.
    const oversizedBlock = `data: ${"x".repeat(1024 * 1024 + 100)}\n\n`;
    const { streamBody } = makeStreamBody([oversizedBlock]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toEqual([
      { type: "status", status: "running" },
      {
        type: "status",
        status: "error",
        error: "Supervisor API error (transport)",
      },
    ]);
    // The raw error text (which echoes the cap detail) never reaches the client.
    for (const e of events) {
      if (e.type === "status" && "error" in e) {
        expect(e.error).not.toContain("maxLineChars");
      }
    }
  });

  test("emits a terminal transport error when the stream closes without any events", async () => {
    // A stream that closes with zero SSE events would otherwise leave the
    // consumer stuck in `running`. The adapter must end the turn with a
    // terminal `transport` error.
    const { streamBody } = makeStreamBody([]);
    const adapter = new SupervisorApiAdapter({
      streamBody,
      model: "databricks-claude-sonnet-4",
    });
    const events = await collect(
      adapter.run(createInput(), { executeTool: vi.fn() }),
    );
    expect(events).toEqual([
      { type: "status", status: "running" },
      {
        type: "status",
        status: "error",
        error: "Supervisor API error (transport)",
      },
    ]);
  });

  test("treats incomplete_details alone as benign truncation: recovers text and completes", async () => {
    // A `max_output_tokens` truncation populates `incomplete_details` while
    // still producing usable partial output. The adapter must NOT treat this
    // as a failure — it recovers the partial text and yields `complete`.
    const { streamBody } = makeStreamBody([
      sseEvent("response.completed", {
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "message",
              id: "msg-trunc",
              role: "assistant",
              content: [{ type: "output_text", text: "Partial answer" }],
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
      { type: "message_delta", content: "Partial answer" },
      { type: "status", status: "complete" },
    ]);
  });

  test("coerces a non-string output_text delta to an empty string", async () => {
    // Hardening for the previous `(data.delta as string) ?? ""` cast: a
    // non-string `delta` (or `item_id`) must not leak through as a non-string
    // or `"undefined"` — it is coerced to "".
    const { streamBody } = makeStreamBody([
      sseEvent("response.output_text.delta", { item_id: 42, delta: 123 }),
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
      { type: "message_delta", content: "" },
      { type: "status", status: "complete" },
    ]);
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

describe("DatabricksAdapter.fromSupervisorApi", () => {
  test("returns a SupervisorApiAdapter instance", async () => {
    const { DatabricksAdapter } = await import("../databricks");
    const adapter = await DatabricksAdapter.fromSupervisorApi({
      model: "databricks-claude-sonnet-4",
      workspaceClient: {
        config: { ensureResolved: vi.fn(async () => {}) },
        apiClient: { request: vi.fn() },
      },
    });
    expect(adapter).toBeInstanceOf(SupervisorApiAdapter);
  });
});
