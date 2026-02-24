import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GeniePlugin } from "../../genie/genie";
import type { GenieMessageResponse } from "../../genie/types";
import { runAgent } from "../agent";
import type { IMultiGenieConfig, MultiGenieStreamEvent } from "../types";

// Mock the LLM client
vi.mock("../llm-client", () => ({
  chatCompletion: vi.fn(),
}));

// Mock getWorkspaceClient
vi.mock("../../../context", () => ({
  getWorkspaceClient: vi.fn(() => ({
    genie: {
      getMessageAttachmentQueryResult: vi.fn().mockResolvedValue({
        statement_response: { status: "SUCCEEDED", result: { data: [] } },
      }),
    },
  })),
}));

// Mock logger
vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { chatCompletion } from "../llm-client";

const mockChatCompletion = vi.mocked(chatCompletion);

function createMockConfig(
  overrides: Partial<IMultiGenieConfig> = {},
): IMultiGenieConfig {
  return {
    genieSpaces: { sales: "space-sales", support: "space-support" },
    genieSpaceDescriptions: {
      sales: "Sales and revenue data",
      support: "Customer support tickets",
    },
    endpoint: "https://example.com/chat/completions",
    model: "test-model",
    endpointToken: "test-token",
    maxIterations: 5,
    ...overrides,
  };
}

function createMockGeniePlugin(): GeniePlugin {
  return {
    sendMessage: vi.fn(),
  } as unknown as GeniePlugin;
}

function createGenieResponse(
  alias: string,
  content: string,
  opts: Partial<GenieMessageResponse> = {},
): GenieMessageResponse {
  return {
    messageId: `msg-${alias}`,
    conversationId: `conv-${alias}`,
    spaceId: `space-${alias}`,
    status: "COMPLETED",
    content,
    attachments: [
      {
        text: { content },
        attachmentId: `att-${alias}`,
        query: {
          title: `${alias} query`,
          query: `SELECT * FROM ${alias}`,
          statementId: `stmt-${alias}`,
        },
      },
    ],
    ...opts,
  };
}

async function collectEvents(
  gen: AsyncGenerator<MultiGenieStreamEvent>,
): Promise<MultiGenieStreamEvent[]> {
  const events: MultiGenieStreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("yields error when no token configured", async () => {
    const config = createMockConfig({ endpointToken: undefined });
    // Clear env
    const origToken = process.env.DATABRICKS_TOKEN;
    delete process.env.DATABRICKS_TOKEN;

    const events = await collectEvents(
      runAgent("hello", { config, geniePlugin: createMockGeniePlugin() }),
    );

    expect(events).toEqual([
      { type: "error", error: "No endpoint token configured" },
    ]);

    if (origToken) process.env.DATABRICKS_TOKEN = origToken;
  });

  test("handles direct answer without tool calls", async () => {
    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: "The answer is 42.",
    });

    const events = await collectEvents(
      runAgent("What is the answer?", {
        config: createMockConfig(),
        geniePlugin: createMockGeniePlugin(),
      }),
    );

    expect(events).toEqual([
      { type: "agent_start", userMessage: "What is the answer?" },
      { type: "agent_thinking", iteration: 0 },
      { type: "answer", content: "The answer is 42." },
    ]);
  });

  test("routes to single space and synthesizes answer", async () => {
    const geniePlugin = createMockGeniePlugin();
    vi.mocked(geniePlugin.sendMessage).mockResolvedValueOnce(
      createGenieResponse("sales", "Q4 revenue was $2.3M"),
    );

    // First call: LLM returns tool call
    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "tc-1",
          type: "function",
          function: {
            name: "query_sales",
            arguments: '{"question":"Q4 revenue"}',
          },
        },
      ],
    });

    // Second call: LLM synthesizes answer
    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: "Q4 revenue was $2.3M based on the sales data.",
    });

    const events = await collectEvents(
      runAgent("What was Q4 revenue?", {
        config: createMockConfig(),
        geniePlugin,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "agent_start",
      "agent_thinking",
      "routing",
      "genie_space_result",
      "genie_query_result",
      "agent_thinking",
      "answer",
    ]);

    // Verify routing event
    const routingEvent = events.find((e) => e.type === "routing");
    expect(routingEvent).toEqual({ type: "routing", genieSpaces: ["sales"] });

    // Verify space_result
    const spaceResult = events.find((e) => e.type === "genie_space_result");
    expect(spaceResult).toMatchObject({
      type: "genie_space_result",
      alias: "sales",
      content: "Q4 revenue was $2.3M",
    });

    // Verify genie was called correctly
    expect(geniePlugin.sendMessage).toHaveBeenCalledWith(
      "sales",
      "Q4 revenue",
      undefined,
    );

    // Verify final answer
    const answer = events.find((e) => e.type === "answer");
    expect(answer).toEqual({
      type: "answer",
      content: "Q4 revenue was $2.3M based on the sales data.",
    });
  });

  test("routes to multiple spaces in parallel", async () => {
    const geniePlugin = createMockGeniePlugin();

    vi.mocked(geniePlugin.sendMessage)
      .mockResolvedValueOnce(
        createGenieResponse("sales", "Q4 revenue was $2.3M"),
      )
      .mockResolvedValueOnce(
        createGenieResponse("support", "Q4 CSAT was 4.2/5"),
      );

    // LLM returns two parallel tool calls
    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "tc-1",
          type: "function",
          function: {
            name: "query_sales",
            arguments: '{"question":"Q4 revenue"}',
          },
        },
        {
          id: "tc-2",
          type: "function",
          function: {
            name: "query_support",
            arguments: '{"question":"Q4 CSAT score"}',
          },
        },
      ],
    });

    // LLM synthesizes
    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: "Q4 had $2.3M revenue with 4.2/5 CSAT.",
    });

    const events = await collectEvents(
      runAgent("Compare Q4 metrics", {
        config: createMockConfig(),
        geniePlugin,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("routing");
    expect(types.filter((t) => t === "genie_space_result")).toHaveLength(2);
    expect(types.filter((t) => t === "genie_query_result")).toHaveLength(2);

    const routingEvent = events.find((e) => e.type === "routing") as Extract<
      MultiGenieStreamEvent,
      { type: "routing" }
    >;
    expect(routingEvent.genieSpaces).toEqual(["sales", "support"]);
  });

  test("handles space error gracefully", async () => {
    const geniePlugin = createMockGeniePlugin();
    vi.mocked(geniePlugin.sendMessage).mockRejectedValueOnce(
      new Error("Space unavailable"),
    );

    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "tc-1",
          type: "function",
          function: {
            name: "query_sales",
            arguments: '{"question":"Q4 revenue"}',
          },
        },
      ],
    });

    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: "I was unable to query the sales space.",
    });

    const events = await collectEvents(
      runAgent("Q4 revenue?", {
        config: createMockConfig(),
        geniePlugin,
      }),
    );

    expect(events.some((e) => e.type === "genie_space_error")).toBe(true);
    const errorEvent = events.find(
      (e) => e.type === "genie_space_error",
    ) as Extract<MultiGenieStreamEvent, { type: "genie_space_error" }>;
    expect(errorEvent.alias).toBe("sales");
    expect(errorEvent.error).toBe("Space unavailable");
  });

  test("respects maxIterations", async () => {
    const geniePlugin = createMockGeniePlugin();
    vi.mocked(geniePlugin.sendMessage).mockResolvedValue(
      createGenieResponse("sales", "data"),
    );

    const config = createMockConfig({ maxIterations: 2 });

    // Both iterations return tool calls (never a final answer)
    mockChatCompletion
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "query_sales", arguments: '{"question":"q1"}' },
          },
        ],
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-2",
            type: "function",
            function: { name: "query_sales", arguments: '{"question":"q2"}' },
          },
        ],
      })
      // Final forced answer
      .mockResolvedValueOnce({
        role: "assistant",
        content: "Forced answer after max iterations.",
      });

    const events = await collectEvents(
      runAgent("complex question", { config, geniePlugin }),
    );

    // Should have 3 thinking events (iterations 0, 1, and maxIterations)
    const thinkingEvents = events.filter((e) => e.type === "agent_thinking");
    expect(thinkingEvents).toHaveLength(3);

    const answer = events.find((e) => e.type === "answer") as Extract<
      MultiGenieStreamEvent,
      { type: "answer" }
    >;
    expect(answer.content).toBe("Forced answer after max iterations.");
  });

  test("reuses conversation ID for same space within request", async () => {
    const geniePlugin = createMockGeniePlugin();

    vi.mocked(geniePlugin.sendMessage)
      .mockResolvedValueOnce(createGenieResponse("sales", "Initial data"))
      .mockResolvedValueOnce(createGenieResponse("sales", "Follow-up data"));

    // First iteration: query sales
    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "tc-1",
          type: "function",
          function: {
            name: "query_sales",
            arguments: '{"question":"initial"}',
          },
        },
      ],
    });

    // Second iteration: follow-up to same space
    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "tc-2",
          type: "function",
          function: {
            name: "query_sales",
            arguments: '{"question":"follow-up"}',
          },
        },
      ],
    });

    // Final answer
    mockChatCompletion.mockResolvedValueOnce({
      role: "assistant",
      content: "Combined answer.",
    });

    await collectEvents(
      runAgent("detailed sales", {
        config: createMockConfig(),
        geniePlugin,
      }),
    );

    // First call: no conversation ID
    expect(geniePlugin.sendMessage).toHaveBeenNthCalledWith(
      1,
      "sales",
      "initial",
      undefined,
    );

    // Second call: should reuse conversation ID from first result
    expect(geniePlugin.sendMessage).toHaveBeenNthCalledWith(
      2,
      "sales",
      "follow-up",
      "conv-sales",
    );
  });
});
