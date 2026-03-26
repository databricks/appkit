import type { AgentEvent, AgentToolDefinition, Message } from "shared";
import { describe, expect, test, vi } from "vitest";
import { LangChainAdapter } from "../langchain";

vi.mock("@langchain/core/tools", () => ({
  DynamicStructuredTool: vi.fn().mockImplementation((config: any) => ({
    name: config.name,
    description: config.description,
    schema: config.schema,
    func: config.func,
  })),
}));

vi.mock("zod", () => {
  const createChainable = (base: Record<string, any> = {}): any => {
    const obj: any = { ...base };
    obj.optional = () => createChainable({ ...obj, _optional: true });
    obj.describe = (d: string) => createChainable({ ...obj, _description: d });
    return obj;
  };

  return {
    z: {
      object: (shape: any) => createChainable({ type: "object", shape }),
      string: () => createChainable({ type: "string" }),
      number: () => createChainable({ type: "number" }),
      boolean: () => createChainable({ type: "boolean" }),
      array: (item: any) => createChainable({ type: "array", item }),
      enum: (vals: any) => createChainable({ type: "enum", values: vals }),
      any: () => createChainable({ type: "any" }),
      null: () => createChainable({ type: "null" }),
    },
  };
});

function createTestMessages(): Message[] {
  return [{ id: "1", role: "user", content: "Hello", createdAt: new Date() }];
}

function createTestTools(): AgentToolDefinition[] {
  return [
    {
      name: "lakebase.query",
      description: "Run SQL",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "SQL query" },
          values: { type: "array", items: {} },
        },
        required: ["text"],
      },
    },
  ];
}

describe("LangChainAdapter", () => {
  test("yields status running on start and maps chat_model_stream", async () => {
    async function* mockStreamEvents() {
      yield {
        event: "on_chat_model_stream",
        data: { chunk: { content: "Hello" } },
      };
      yield {
        event: "on_chat_model_stream",
        data: { chunk: { content: " world" } },
      };
    }

    const mockRunnable = {
      bindTools: vi.fn().mockReturnValue({
        streamEvents: vi.fn().mockResolvedValue(mockStreamEvents()),
      }),
    };

    const adapter = new LangChainAdapter({ runnable: mockRunnable });
    const events: AgentEvent[] = [];

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

    expect(events[0]).toEqual({ type: "status", status: "running" });
    expect(events[1]).toEqual({ type: "message_delta", content: "Hello" });
    expect(events[2]).toEqual({ type: "message_delta", content: " world" });
  });

  test("maps on_tool_end events to tool_result", async () => {
    async function* mockStreamEvents() {
      yield {
        event: "on_tool_end",
        run_id: "run-1",
        data: { output: { content: "42 rows" } },
      };
    }

    const mockRunnable = {
      bindTools: vi.fn().mockReturnValue({
        streamEvents: vi.fn().mockResolvedValue(mockStreamEvents()),
      }),
    };

    const adapter = new LangChainAdapter({ runnable: mockRunnable });
    const events: AgentEvent[] = [];

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

    expect(events).toContainEqual({
      type: "tool_result",
      callId: "run-1",
      result: "42 rows",
    });
  });

  test("calls bindTools when tools are provided", async () => {
    const streamEvents = vi.fn().mockResolvedValue((async function* () {})());
    const bindTools = vi.fn().mockReturnValue({ streamEvents });

    const adapter = new LangChainAdapter({
      runnable: { bindTools },
    });

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

    expect(bindTools).toHaveBeenCalledTimes(1);
    expect(bindTools.mock.calls[0][0]).toHaveLength(1);
    expect(bindTools.mock.calls[0][0][0].name).toBe("lakebase.query");
  });

  test("does not call bindTools when no tools provided", async () => {
    const streamEvents = vi.fn().mockResolvedValue((async function* () {})());
    const bindTools = vi.fn().mockReturnValue({ streamEvents });

    const adapter = new LangChainAdapter({
      runnable: { bindTools, streamEvents },
    });

    for await (const _ of adapter.run(
      {
        messages: createTestMessages(),
        tools: [],
        threadId: "t1",
      },
      { executeTool: vi.fn() },
    )) {
      // drain
    }

    expect(bindTools).not.toHaveBeenCalled();
  });
});
