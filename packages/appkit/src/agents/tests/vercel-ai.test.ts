import type { AgentEvent, AgentToolDefinition, Message } from "shared";
import { describe, expect, test, vi } from "vitest";
import { VercelAIAdapter } from "../vercel-ai";

vi.mock("ai", () => ({
  streamText: vi.fn(),
  jsonSchema: vi.fn((schema: any) => schema),
}));

function createTestMessages(): Message[] {
  return [
    {
      id: "1",
      role: "user",
      content: "Hello",
      createdAt: new Date(),
    },
  ];
}

function createTestTools(): AgentToolDefinition[] {
  return [
    {
      name: "analytics.query",
      description: "Run SQL",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  ];
}

describe("VercelAIAdapter", () => {
  test("yields status running on start", async () => {
    const { streamText } = await import("ai");

    async function* mockStream() {
      yield { type: "text-delta", textDelta: "Hi" };
    }

    (streamText as any).mockReturnValue({
      fullStream: mockStream(),
    });

    const adapter = new VercelAIAdapter({ model: {} });
    const events: AgentEvent[] = [];

    const stream = adapter.run(
      {
        messages: createTestMessages(),
        tools: createTestTools(),
        threadId: "t1",
      },
      {
        executeTool: vi.fn(),
      },
    );

    for await (const event of stream) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "status", status: "running" });
    expect(events[1]).toEqual({ type: "message_delta", content: "Hi" });
  });

  test("maps tool-call and tool-result events", async () => {
    const { streamText } = await import("ai");

    async function* mockStream() {
      yield {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "analytics.query",
        args: { query: "SELECT 1" },
      };
      yield {
        type: "tool-result",
        toolCallId: "c1",
        result: [{ value: 1 }],
      };
    }

    (streamText as any).mockReturnValue({
      fullStream: mockStream(),
    });

    const adapter = new VercelAIAdapter({ model: {} });
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
      type: "tool_call",
      callId: "c1",
      name: "analytics.query",
      args: { query: "SELECT 1" },
    });

    expect(events).toContainEqual({
      type: "tool_result",
      callId: "c1",
      result: [{ value: 1 }],
    });
  });

  test("maps error events", async () => {
    const { streamText } = await import("ai");

    async function* mockStream() {
      yield { type: "error", error: "API rate limited" };
    }

    (streamText as any).mockReturnValue({
      fullStream: mockStream(),
    });

    const adapter = new VercelAIAdapter({ model: {} });
    const events: AgentEvent[] = [];

    for await (const event of adapter.run(
      {
        messages: createTestMessages(),
        tools: [],
        threadId: "t1",
      },
      { executeTool: vi.fn() },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "status",
      status: "error",
      error: "API rate limited",
    });
  });

  test("builds tools with execute functions that delegate to executeTool", async () => {
    const { streamText } = await import("ai");

    let capturedTools: Record<string, any> = {};

    (streamText as any).mockImplementation((opts: any) => {
      capturedTools = opts.tools;
      return {
        fullStream: (async function* () {})(),
      };
    });

    const executeTool = vi.fn().mockResolvedValue({ count: 42 });
    const adapter = new VercelAIAdapter({ model: {} });

    // Consume the stream to trigger streamText
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

    expect(capturedTools["analytics.query"]).toBeDefined();
    expect(capturedTools["analytics.query"].description).toBe("Run SQL");

    const result = await capturedTools["analytics.query"].execute({
      query: "SELECT 1",
    });
    expect(executeTool).toHaveBeenCalledWith("analytics.query", {
      query: "SELECT 1",
    });
    expect(result).toEqual({ count: 42 });
  });
});
