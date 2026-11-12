import { describe, expect, test, vi } from "vitest";

import { GenieConnector } from "../client";
import type { GenieStreamEvent } from "../types";

// Shapes trimmed from a real agent-mode turn ("Show total sales by franchise country as a bar chart").
const AGENT_ID = "agent-1";
const CONV = "conv-1";
const MSG = "msg-1";

const created = {
  type: "response.created",
  response: { id: MSG, conversation_id: CONV, status: "in_progress" },
};
const reasoningItem = (text: string) => ({
  type: "reasoning",
  status: "completed",
  content: [{ type: "reasoning_text", text }],
  metadata: { message_id: MSG },
});
const toolCall = (name: string) => ({
  type: "function_call",
  status: "completed",
  name,
  arguments: "{}",
  metadata: { message_id: MSG },
});
const answerItem = {
  type: "message",
  role: "assistant",
  status: "completed",
  content: [
    { type: "output_text", text: "## Franchises by country" },
    {
      type: "output_text",
      text: "",
      metadata: { viz: { attachment_id: "viz-1" } },
    },
    { type: "output_text", text: "Japan has the most." },
  ],
  metadata: { message_id: MSG },
};
const done = (item: object) => ({ type: "response.output_item.done", item });
const completed = {
  type: "response.completed",
  response: { id: MSG, conversation_id: CONV, status: "completed" },
};

/** The message projection of the same turn: queries and charts, no answer text. */
const projection = {
  messageId: MSG,
  conversationId: CONV,
  spaceId: AGENT_ID,
  status: "COMPLETED",
  content: "Show franchises by country",
  attachments: [
    {
      attachmentId: "query-1",
      attachment: {
        $case: "query",
        query: {
          title: "Franchises by country",
          query: "SELECT country, count(*) FROM franchises GROUP BY 1",
          statementId: "stmt-1",
        },
      },
    },
    {
      attachmentId: "viz-1",
      attachment: {
        $case: "viz",
        viz: { title: "Franchises by Country", queryAttachmentId: "query-1" },
      },
    },
  ],
};

const expectedMessage = {
  messageId: MSG,
  conversationId: CONV,
  spaceId: AGENT_ID,
  status: "COMPLETED",
  content: "Show franchises by country",
  attachments: [
    {
      attachmentId: "query-1",
      query: {
        title: "Franchises by country",
        query: "SELECT country, count(*) FROM franchises GROUP BY 1",
        statementId: "stmt-1",
      },
    },
    {
      attachmentId: "viz-1",
      viz: { title: "Franchises by Country", queryAttachmentId: "query-1" },
    },
    { text: { content: "## Franchises by country\n\nJapan has the most." } },
  ],
  reasoning: [
    "I'll chart franchises by country.",
    "There are no sales figures.",
  ],
};

function sse(events: object[]): Response {
  return new Response(
    events
      .map(
        (e) =>
          `event:${(e as { type: string }).type}\ndata:${JSON.stringify(e)}\n\n`,
      )
      .join(""),
  );
}

function createMockWorkspaceClient() {
  return {
    request: vi.fn(),
    genie: {
      genieGetConversationMessage: vi.fn().mockResolvedValue(projection),
      genieListConversationMessages: vi.fn(),
      genieGetMessageAttachmentQueryResult: vi.fn().mockResolvedValue({
        statementResponse: {
          manifest: { schema: { columns: [] } },
          result: {},
        },
      }),
      downloadMessageAttachmentVisualization: vi.fn(),
    },
  } as any;
}

async function collect(
  gen: AsyncGenerator<GenieStreamEvent>,
): Promise<GenieStreamEvent[]> {
  const events: GenieStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const fullTurn = [
  created,
  {
    type: "response.output_item.added",
    item: reasoningItem("I'll chart franchises by country."),
  },
  done(reasoningItem("I'll chart franchises by country.")),
  done(reasoningItem("There are no sales figures.")),
  done(toolCall("execute_sql")),
  done(toolCall("generate_visualization")),
  done(answerItem),
  completed,
];

describe("GenieConnector agent mode", () => {
  describe("streamAgentResponse", () => {
    test("maps an agent turn onto the chat-mode events plus reasoning", async () => {
      const ws = createMockWorkspaceClient();
      ws.request.mockResolvedValue(sse(fullTurn));

      const events = await collect(
        new GenieConnector().streamAgentResponse(
          ws,
          AGENT_ID,
          "Show franchises",
          undefined,
        ),
      );

      expect(events).toEqual([
        {
          type: "message_start",
          conversationId: CONV,
          messageId: MSG,
          spaceId: AGENT_ID,
        },
        { type: "reasoning", content: "I'll chart franchises by country." },
        { type: "reasoning", content: "There are no sales figures." },
        { type: "status", status: "EXECUTING_QUERY" },
        { type: "status", status: "GENERATING_VISUALIZATION" },
        { type: "message_result", message: expectedMessage },
        expect.objectContaining({
          type: "query_result",
          attachmentId: "query-1",
          statementId: "stmt-1",
        }),
      ]);
      expect(ws.genie.genieGetConversationMessage).toHaveBeenCalledWith(
        { spaceId: AGENT_ID, conversationId: CONV, messageId: MSG },
        expect.anything(),
      );
    });

    test("starts a new conversation with viz enabled", async () => {
      const ws = createMockWorkspaceClient();
      ws.request.mockResolvedValue(sse(fullTurn));

      await collect(
        new GenieConnector().streamAgentResponse(ws, AGENT_ID, "Hi", undefined),
      );

      const req = ws.request.mock.calls[0][0];
      expect(req).toMatchObject({
        method: "POST",
        path: "/api/2.0/genie/agents/agent-1/responses",
      });
      expect(req.headers.get("Accept")).toBe("text/event-stream");
      expect(JSON.parse(req.body)).toEqual({
        enable_viz: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hi" }],
          },
        ],
      });
    });

    test("continues an existing conversation", async () => {
      const ws = createMockWorkspaceClient();
      ws.request.mockResolvedValue(sse(fullTurn));

      await collect(
        new GenieConnector().streamAgentResponse(
          ws,
          AGENT_ID,
          "And now?",
          CONV,
        ),
      );

      expect(JSON.parse(ws.request.mock.calls[0][0].body)).toMatchObject({
        conversation_id: CONV,
      });
    });

    test("yields an error when the agent fails", async () => {
      const ws = createMockWorkspaceClient();
      ws.request.mockResolvedValue(
        sse([
          created,
          {
            type: "response.failed",
            response: {
              id: MSG,
              conversation_id: CONV,
              error: { message: "boom" },
            },
          },
        ]),
      );

      const events = await collect(
        new GenieConnector().streamAgentResponse(ws, AGENT_ID, "Hi", undefined),
      );

      expect(events.map((e) => e.type)).toEqual(["message_start", "error"]);
      expect(events[1]).toEqual({ type: "error", error: "boom" });
    });

    test("yields an error when the stream ends before the turn completes", async () => {
      const ws = createMockWorkspaceClient();
      ws.request.mockResolvedValue(
        sse([created, done(reasoningItem("thinking"))]),
      );

      const events = await collect(
        new GenieConnector().streamAgentResponse(ws, AGENT_ID, "Hi", undefined),
      );

      expect(events.at(-1)).toEqual({
        type: "error",
        error: "Genie agent response ended before it completed",
      });
      expect(ws.genie.genieGetConversationMessage).not.toHaveBeenCalled();
    });

    test("surfaces the message of an agent API error body", async () => {
      const ws = createMockWorkspaceClient();
      ws.request.mockRejectedValue(
        Object.assign(new Error("Response from server (Not Found)"), {
          response: {
            error: {
              type: "NOT_FOUND",
              message: "NOT_FOUND: Space with id agent-1 not found",
            },
          },
        }),
      );

      const events = await collect(
        new GenieConnector().streamAgentResponse(ws, AGENT_ID, "Hi", undefined),
      );

      expect(events).toEqual([
        { type: "error", error: "NOT_FOUND: Space with id agent-1 not found" },
      ]);
    });
  });

  describe("history", () => {
    // The items endpoint pages oldest first; a turn can span pages.
    function mockItemPages(ws: ReturnType<typeof createMockWorkspaceClient>) {
      ws.request
        .mockResolvedValueOnce(
          Response.json({
            data: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: "Show franchises by country" },
                ],
                metadata: { message_id: MSG },
              },
              reasoningItem("I'll chart franchises by country."),
              reasoningItem("There are no sales figures."),
            ],
            has_more: true,
            last_id: "item-3",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            data: [toolCall("execute_sql"), answerItem],
            has_more: false,
          }),
        );
    }

    test("streamConversation adds answer text and reasoning from the items", async () => {
      const ws = createMockWorkspaceClient();
      ws.genie.genieListConversationMessages.mockResolvedValue({
        messages: [projection],
      });
      mockItemPages(ws);

      const events = await collect(
        new GenieConnector().streamConversation(ws, AGENT_ID, CONV, {
          agent: true,
          includeQueryResults: false,
        }),
      );

      expect(events[0]).toEqual({
        type: "message_result",
        message: expectedMessage,
      });
      expect(ws.request).toHaveBeenCalledTimes(2);
      expect(ws.request.mock.calls[0][0]).toMatchObject({
        method: "GET",
        path: "/api/2.0/genie/agents/agent-1/conversations/conv-1/items",
        query: { limit: "100" },
      });
      expect(ws.request.mock.calls[1][0].query).toEqual({
        limit: "100",
        after: "item-3",
      });
    });

    test("streamGetMessage adds answer text and reasoning once the message is done", async () => {
      const ws = createMockWorkspaceClient();
      mockItemPages(ws);

      const events = await collect(
        new GenieConnector().streamGetMessage(ws, AGENT_ID, CONV, MSG, {
          agent: true,
        }),
      );

      expect(events.find((e) => e.type === "message_result")).toEqual({
        type: "message_result",
        message: expectedMessage,
      });
    });

    test("getConversation adds answer text and reasoning", async () => {
      const ws = createMockWorkspaceClient();
      ws.genie.genieListConversationMessages.mockResolvedValue({
        messages: [projection],
      });
      mockItemPages(ws);

      const history = await new GenieConnector().getConversation(
        ws,
        AGENT_ID,
        CONV,
        { agent: true },
      );

      expect(history.messages).toEqual([expectedMessage]);
    });

    test("chat-mode history doesn't read agent items", async () => {
      const ws = createMockWorkspaceClient();
      ws.genie.genieListConversationMessages.mockResolvedValue({
        messages: [projection],
      });

      await collect(
        new GenieConnector().streamConversation(ws, AGENT_ID, CONV, {
          includeQueryResults: false,
        }),
      );

      expect(ws.request).not.toHaveBeenCalled();
    });
  });

  describe("downloadVisualization", () => {
    test("requests the attachment's rendered PNG", async () => {
      const ws = createMockWorkspaceClient();
      const png = new ReadableStream();
      ws.genie.downloadMessageAttachmentVisualization.mockResolvedValue({
        contents: png,
      });

      const result = await new GenieConnector().downloadVisualization(
        ws,
        AGENT_ID,
        CONV,
        MSG,
        "viz-1_output",
      );

      expect(result).toBe(png);
      expect(
        ws.genie.downloadMessageAttachmentVisualization,
      ).toHaveBeenCalledWith(
        {
          name: "spaces/agent-1/conversations/conv-1/messages/msg-1/attachments/viz-1_output",
        },
        expect.anything(),
      );
    });

    test("rejects ids that could change the resource path", async () => {
      const ws = createMockWorkspaceClient();

      await expect(
        new GenieConnector().downloadVisualization(
          ws,
          AGENT_ID,
          CONV,
          MSG,
          "../../x",
        ),
      ).rejects.toThrow("Invalid Genie id");
      expect(
        ws.genie.downloadMessageAttachmentVisualization,
      ).not.toHaveBeenCalled();
    });
  });
});
