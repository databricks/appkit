import type { AgentEvent, Message } from "shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SupervisorApiHostedTool } from "../responses";
import { SupervisorApiAdapter } from "../responses";

const mockAuthenticate = vi
  .fn()
  .mockImplementation(async (headers: Headers) => {
    headers.set("authorization", "Bearer test-token");
  });

const mockConfig = {
  host: "https://test-workspace.databricks.com",
  authenticate: mockAuthenticate,
  ensureResolved: vi.fn().mockResolvedValue(undefined),
};

const mockWorkspaceClient = { config: mockConfig };

function sseChunk(data: string): string {
  return `data: ${data}\n\n`;
}

function textDelta(content: string): string {
  return sseChunk(
    JSON.stringify({
      type: "response.output_text.delta",
      delta: content,
      item_id: "msg_test",
      step: 1,
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

async function collectEvents(
  gen: AsyncGenerator<AgentEvent, void, unknown>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function mockFetchStream(chunks: string[]) {
  return vi.fn().mockResolvedValue(
    new Response(createReadableStream(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("SupervisorApiAdapter", () => {
  describe("tools passed inline", () => {
    test("sends SA-native tools in request body", async () => {
      const tools: SupervisorApiHostedTool[] = [
        {
          type: "genie_space",
          genie_space: { id: "space-1", description: "SQL queries" },
        },
        { type: "app", app: { name: "my-app", description: "Custom app" } },
        {
          type: "uc_connection",
          uc_connection: { name: "my-conn", description: "Web search" },
        },
        {
          type: "uc_function",
          uc_function: { name: "cat.schema.fn", description: "A function" },
        },
        {
          type: "knowledge_assistant",
          knowledge_assistant: {
            knowledge_assistant_id: "ka-1",
            description: "Docs",
          },
        },
      ];

      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "databricks-gpt-5-2",
        tools,
      });

      globalThis.fetch = mockFetchStream([sseChunk("[DONE]")]);

      await collectEvents(
        adapter.run(
          {
            messages: [
              { id: "1", role: "user", content: "Hi", createdAt: new Date() },
            ],
            tools: [],
            threadId: "t1",
          },
          { executeTool: async () => "", signal: undefined },
        ),
      );

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.model).toBe("databricks-gpt-5-2");
      expect(body.tools).toEqual(tools);
    });

    test("omits tools key when no tools provided", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "test-model",
      });

      globalThis.fetch = mockFetchStream([sseChunk("[DONE]")]);

      await collectEvents(
        adapter.run(
          {
            messages: [
              { id: "1", role: "user", content: "Hi", createdAt: new Date() },
            ],
            tools: [],
            threadId: "t1",
          },
          { executeTool: async () => "", signal: undefined },
        ),
      );

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.tools).toBeUndefined();
    });
  });

  describe("configure", () => {
    test("warns about plugin tool definitions that require local execution", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "test-model",
      });

      await adapter.configure({
        tools: [],
        toolDefinitions: [
          {
            name: "analytics.query",
            description: "Run SQL",
            parameters: { type: "object" },
          },
          {
            name: "files.list",
            description: "List files",
            parameters: { type: "object" },
          },
        ],
      });
    });
  });

  describe("run", () => {
    test("POSTs to /ai-gateway/mlflow/v1/responses with correct URL", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "databricks-gpt-5-2",
        instructions: "Be helpful",
      });

      globalThis.fetch = mockFetchStream([sseChunk("[DONE]")]);

      await collectEvents(
        adapter.run(
          {
            messages: [
              { id: "1", role: "user", content: "Hi", createdAt: new Date() },
            ],
            tools: [],
            threadId: "t1",
          },
          { executeTool: async () => "", signal: undefined },
        ),
      );

      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toBe(
        "https://test-workspace.databricks.com/ai-gateway/mlflow/v1/responses",
      );
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body);
      expect(body.model).toBe("databricks-gpt-5-2");
      expect(body.instructions).toBe("Be helpful");
      expect(body.input).toEqual([{ role: "user", content: "Hi" }]);
      expect(body.stream).toBe(true);
    });

    test("sends full message history in input", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "test-model",
      });

      globalThis.fetch = mockFetchStream([sseChunk("[DONE]")]);

      const messages: Message[] = [
        { id: "1", role: "user", content: "Hello", createdAt: new Date() },
        {
          id: "2",
          role: "assistant",
          content: "Hi there!",
          createdAt: new Date(),
        },
        {
          id: "3",
          role: "user",
          content: "What's 2+2?",
          createdAt: new Date(),
        },
      ];

      await collectEvents(
        adapter.run(
          { messages, tools: [], threadId: "t1" },
          { executeTool: async () => "", signal: undefined },
        ),
      );

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.input).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "What's 2+2?" },
      ]);
    });

    test("streams text deltas from SSE", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "test-model",
      });

      globalThis.fetch = mockFetchStream([
        textDelta("Hello"),
        textDelta(" world"),
        sseChunk("[DONE]"),
      ]);

      const events = await collectEvents(
        adapter.run(
          {
            messages: [
              { id: "1", role: "user", content: "Hi", createdAt: new Date() },
            ],
            tools: [],
            threadId: "t1",
          },
          { executeTool: async () => "", signal: undefined },
        ),
      );

      expect(events[0]).toEqual({ type: "status", status: "running" });
      expect(events[1]).toEqual({ type: "message_delta", content: "Hello" });
      expect(events[2]).toEqual({ type: "message_delta", content: " world" });
    });

    test("falls back to output_item.done message when no deltas received", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "test-model",
      });

      globalThis.fetch = mockFetchStream([
        sseChunk(
          JSON.stringify({
            type: "response.output_item.done",
            item: {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [
                { type: "output_text", text: "Hello from non-streaming!" },
              ],
            },
          }),
        ),
        sseChunk("[DONE]"),
      ]);

      const events = await collectEvents(
        adapter.run(
          {
            messages: [
              { id: "1", role: "user", content: "Hi", createdAt: new Date() },
            ],
            tools: [],
            threadId: "t1",
          },
          { executeTool: async () => "", signal: undefined },
        ),
      );

      expect(events[1]).toEqual({
        type: "message_delta",
        content: "Hello from non-streaming!",
      });
    });

    test("does not duplicate when deltas are followed by output_item.done", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "test-model",
      });

      globalThis.fetch = mockFetchStream([
        textDelta("Hello"),
        sseChunk(
          JSON.stringify({
            type: "response.output_item.done",
            item: {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello" }],
            },
          }),
        ),
        sseChunk("[DONE]"),
      ]);

      const events = await collectEvents(
        adapter.run(
          {
            messages: [
              { id: "1", role: "user", content: "Hi", createdAt: new Date() },
            ],
            tools: [],
            threadId: "t1",
          },
          { executeTool: async () => "", signal: undefined },
        ),
      );

      const messageEvents = events.filter((e) => e.type === "message_delta");
      expect(messageEvents).toHaveLength(1);
      expect(messageEvents[0]).toEqual({
        type: "message_delta",
        content: "Hello",
      });
    });

    test("yields tool_call events from response.output_item.done", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "test-model",
      });

      globalThis.fetch = mockFetchStream([
        sseChunk(
          JSON.stringify({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_1",
              name: "genie_query",
              arguments: '{"q":"sales"}',
            },
            step: 1,
          }),
        ),
        textDelta("The answer is 42."),
        sseChunk("[DONE]"),
      ]);

      const events = await collectEvents(
        adapter.run(
          {
            messages: [
              {
                id: "1",
                role: "user",
                content: "query",
                createdAt: new Date(),
              },
            ],
            tools: [],
            threadId: "t2",
          },
          { executeTool: async () => "", signal: undefined },
        ),
      );

      expect(events).toContainEqual({
        type: "tool_call",
        callId: "call_1",
        name: "genie_query",
        args: '{"q":"sales"}',
      });
      expect(events).toContainEqual({
        type: "message_delta",
        content: "The answer is 42.",
      });
    });

    test("throws on non-OK response", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: mockWorkspaceClient,
        model: "test-model",
      });

      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response('{"error":"bad request"}', { status: 400 }),
        );

      await expect(
        collectEvents(
          adapter.run(
            {
              messages: [
                { id: "1", role: "user", content: "Hi", createdAt: new Date() },
              ],
              tools: [],
              threadId: "t1",
            },
            { executeTool: async () => "", signal: undefined },
          ),
        ),
      ).rejects.toThrow("Supervisor API error (400)");
    });

    test("normalizes host without protocol", async () => {
      const adapter = await SupervisorApiAdapter.create({
        workspaceClient: {
          config: {
            ...mockConfig,
            host: "my-workspace.databricks.com",
          },
        },
        model: "test-model",
      });

      globalThis.fetch = mockFetchStream([sseChunk("[DONE]")]);

      await collectEvents(
        adapter.run(
          {
            messages: [
              { id: "1", role: "user", content: "Hi", createdAt: new Date() },
            ],
            tools: [],
            threadId: "t1",
          },
          { executeTool: async () => "", signal: undefined },
        ),
      );

      const url = (globalThis.fetch as any).mock.calls[0][0];
      expect(url).toBe(
        "https://my-workspace.databricks.com/ai-gateway/mlflow/v1/responses",
      );
    });
  });
});
