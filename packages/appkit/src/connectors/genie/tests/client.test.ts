import type { GenieMessage } from "@databricks/sdk-experimental/dist/apis/dashboards";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GenieConnector } from "../client";
import type { GenieStreamEvent } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect(
  gen: AsyncGenerator<GenieStreamEvent>,
): Promise<GenieStreamEvent[]> {
  const events: GenieStreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeGenieMessage(overrides: Partial<GenieMessage> = {}): GenieMessage {
  return {
    message_id: "msg-1",
    conversation_id: "conv-1",
    space_id: "space-1",
    status: "COMPLETED",
    content: "Hello from Genie",
    attachments: [],
    ...overrides,
  } as GenieMessage;
}

function makeGenieMessageWithQuery(
  overrides: Partial<GenieMessage> = {},
): GenieMessage {
  return makeGenieMessage({
    attachments: [
      {
        attachment_id: "att-1",
        query: {
          title: "Sales Query",
          description: "Total sales",
          query: "SELECT sum(amount) FROM sales",
          statement_id: "stmt-1",
        },
      },
    ],
    ...overrides,
  });
}

/** Creates a mock WorkspaceClient with genie methods stubbed. */
function createMockWorkspaceClient() {
  return {
    genie: {
      startConversation: vi.fn(),
      createMessage: vi.fn(),
      getMessage: vi.fn(),
      listConversationMessages: vi.fn(),
      getMessageAttachmentQueryResult: vi.fn(),
    },
  } as any;
}

/**
 * Builds a mock waiter whose `.wait()` invokes `onProgress` for each
 * progress value, then resolves with the final result.
 */
function createMockWaiter(opts: {
  progressValues?: Partial<GenieMessage>[];
  result: GenieMessage;
}) {
  return {
    wait: vi.fn().mockImplementation(async (options: any = {}) => {
      if (opts.progressValues) {
        for (const value of opts.progressValues) {
          if (options.onProgress) {
            await options.onProgress(value);
          }
        }
      }
      return opts.result;
    }),
    message_id: opts.result.message_id,
    conversation_id: opts.result.conversation_id,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GenieConnector", () => {
  let connector: GenieConnector;
  let ws: ReturnType<typeof createMockWorkspaceClient>;

  beforeEach(() => {
    connector = new GenieConnector({ timeout: 0 });
    ws = createMockWorkspaceClient();
  });

  // -----------------------------------------------------------------------
  // streamSendMessage
  // -----------------------------------------------------------------------

  describe("streamSendMessage", () => {
    test("yields message_start, status updates, then message_result", async () => {
      const completedMsg = makeGenieMessage();
      const waiter = createMockWaiter({
        progressValues: [
          { status: "EXECUTING_QUERY" },
          { status: "COMPLETED" },
        ],
        result: completedMsg,
      });
      ws.genie.startConversation.mockResolvedValue(waiter);

      const events = await collect(
        connector.streamSendMessage(
          ws,
          "space-1",
          "What are sales?",
          undefined,
        ),
      );

      expect(events[0]).toEqual({
        type: "message_start",
        conversationId: "conv-1",
        messageId: "msg-1",
        spaceId: "space-1",
      });

      const statusEvents = events.filter((e) => e.type === "status");
      expect(statusEvents).toEqual([
        { type: "status", status: "EXECUTING_QUERY" },
        { type: "status", status: "COMPLETED" },
      ]);

      const msgResult = events.find((e) => e.type === "message_result");
      expect(msgResult).toBeDefined();
      expect((msgResult as any).message.messageId).toBe("msg-1");
    });

    test("new conversation calls startConversation", async () => {
      const completedMsg = makeGenieMessage();
      const waiter = createMockWaiter({ result: completedMsg });
      ws.genie.startConversation.mockResolvedValue(waiter);

      await collect(
        connector.streamSendMessage(ws, "space-1", "hello", undefined),
      );

      expect(ws.genie.startConversation).toHaveBeenCalledWith({
        space_id: "space-1",
        content: "hello",
      });
      expect(ws.genie.createMessage).not.toHaveBeenCalled();
    });

    test("existing conversation calls createMessage", async () => {
      const completedMsg = makeGenieMessage();
      const waiter = createMockWaiter({ result: completedMsg });
      ws.genie.createMessage.mockResolvedValue(waiter);

      await collect(
        connector.streamSendMessage(ws, "space-1", "hello", "conv-existing"),
      );

      expect(ws.genie.createMessage).toHaveBeenCalledWith({
        space_id: "space-1",
        conversation_id: "conv-existing",
        content: "hello",
      });
      expect(ws.genie.startConversation).not.toHaveBeenCalled();
    });

    test("emits query_result for attachments with statementIds", async () => {
      const completedMsg = makeGenieMessageWithQuery();
      const waiter = createMockWaiter({ result: completedMsg });
      ws.genie.startConversation.mockResolvedValue(waiter);

      const statementResponse = {
        manifest: {
          schema: { columns: [{ name: "total", type_name: "DOUBLE" }] },
        },
        result: { data_array: [["1234.56"]] },
      };
      ws.genie.getMessageAttachmentQueryResult.mockResolvedValue({
        statement_response: statementResponse,
      });

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "query", undefined),
      );

      const queryResult = events.find((e) => e.type === "query_result");
      expect(queryResult).toEqual({
        type: "query_result",
        attachmentId: "att-1",
        statementId: "stmt-1",
        data: statementResponse,
      });
    });

    test("yields error event on SDK failure", async () => {
      ws.genie.startConversation.mockRejectedValue(
        new Error("Network timeout"),
      );

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "hello", undefined),
      );

      expect(events).toEqual([{ type: "error", error: "Network timeout" }]);
    });

    test("classifies RESOURCE_DOES_NOT_EXIST as access denied", async () => {
      ws.genie.startConversation.mockRejectedValue(
        new Error("RESOURCE_DOES_NOT_EXIST: space not found"),
      );

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "hello", undefined),
      );

      expect(events).toEqual([
        {
          type: "error",
          error: "You don't have access to this Genie Space.",
        },
      ]);
    });

    test("emits error event when query result fetch fails", async () => {
      const completedMsg = makeGenieMessageWithQuery();
      const waiter = createMockWaiter({ result: completedMsg });
      ws.genie.startConversation.mockResolvedValue(waiter);
      ws.genie.getMessageAttachmentQueryResult.mockRejectedValue(
        new Error("statement expired"),
      );

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "query", undefined),
      );

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toEqual({
        type: "error",
        error: "Failed to fetch query result for attachment att-1",
      });
    });
  });

  // -----------------------------------------------------------------------
  // streamConversation
  // -----------------------------------------------------------------------

  describe("streamConversation", () => {
    test("yields message_result for each message, then history_info", async () => {
      ws.genie.listConversationMessages.mockResolvedValue({
        messages: [
          makeGenieMessage({ message_id: "m1", content: "first" }),
          makeGenieMessage({ message_id: "m2", content: "second" }),
        ],
        next_page_token: null,
      });

      const events = await collect(
        connector.streamConversation(ws, "space-1", "conv-1", {
          includeQueryResults: false,
        }),
      );

      const messageResults = events.filter((e) => e.type === "message_result");
      expect(messageResults).toHaveLength(2);

      const historyInfo = events.find((e) => e.type === "history_info");
      expect(historyInfo).toEqual({
        type: "history_info",
        conversationId: "conv-1",
        spaceId: "space-1",
        nextPageToken: null,
        loadedCount: 2,
      });
    });

    test("fetches query results in parallel when includeQueryResults=true", async () => {
      ws.genie.listConversationMessages.mockResolvedValue({
        messages: [
          makeGenieMessageWithQuery({
            message_id: "m1",
            attachments: [
              {
                attachment_id: "att-a",
                query: {
                  title: "Q1",
                  query: "SELECT 1",
                  statement_id: "stmt-a",
                },
              },
              {
                attachment_id: "att-b",
                query: {
                  title: "Q2",
                  query: "SELECT 2",
                  statement_id: "stmt-b",
                },
              },
            ],
          }),
        ],
        next_page_token: null,
      });

      const stmtResponse = {
        manifest: { schema: { columns: [] } },
        result: { data_array: [] },
      };
      ws.genie.getMessageAttachmentQueryResult.mockResolvedValue({
        statement_response: stmtResponse,
      });

      const events = await collect(
        connector.streamConversation(ws, "space-1", "conv-1", {
          includeQueryResults: true,
        }),
      );

      const queryResults = events.filter((e) => e.type === "query_result");
      expect(queryResults).toHaveLength(2);
      expect(ws.genie.getMessageAttachmentQueryResult).toHaveBeenCalledTimes(2);
    });

    test("skips query results when includeQueryResults=false", async () => {
      ws.genie.listConversationMessages.mockResolvedValue({
        messages: [makeGenieMessageWithQuery()],
        next_page_token: null,
      });

      const events = await collect(
        connector.streamConversation(ws, "space-1", "conv-1", {
          includeQueryResults: false,
        }),
      );

      expect(events.filter((e) => e.type === "query_result")).toHaveLength(0);
      expect(ws.genie.getMessageAttachmentQueryResult).not.toHaveBeenCalled();
    });

    test("handles partial query result failures via Promise.allSettled", async () => {
      ws.genie.listConversationMessages.mockResolvedValue({
        messages: [
          makeGenieMessage({
            message_id: "m1",
            attachments: [
              {
                attachment_id: "att-ok",
                query: {
                  title: "OK",
                  query: "SELECT 1",
                  statement_id: "stmt-ok",
                },
              },
              {
                attachment_id: "att-fail",
                query: {
                  title: "Fail",
                  query: "SELECT 2",
                  statement_id: "stmt-fail",
                },
              },
            ],
          }),
        ],
        next_page_token: null,
      });

      const stmtResponse = {
        manifest: { schema: { columns: [] } },
        result: { data_array: [] },
      };

      ws.genie.getMessageAttachmentQueryResult
        .mockResolvedValueOnce({ statement_response: stmtResponse })
        .mockRejectedValueOnce(new Error("statement expired"));

      const events = await collect(
        connector.streamConversation(ws, "space-1", "conv-1", {
          includeQueryResults: true,
        }),
      );

      const queryResults = events.filter((e) => e.type === "query_result");
      expect(queryResults).toHaveLength(1);

      const errors = events.filter((e) => e.type === "error");
      expect(errors).toHaveLength(1);
      expect((errors[0] as any).error).toBe("statement expired");
    });

    test("yields error when listConversationMessages fails", async () => {
      ws.genie.listConversationMessages.mockRejectedValue(
        new Error("RESOURCE_DOES_NOT_EXIST: conv not found"),
      );

      const events = await collect(
        connector.streamConversation(ws, "space-1", "conv-1"),
      );

      expect(events).toEqual([
        {
          type: "error",
          error: "You don't have access to this Genie Space.",
        },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // streamGetMessage
  // -----------------------------------------------------------------------

  describe("streamGetMessage", () => {
    test("polls until COMPLETED, yields status + message_result", async () => {
      ws.genie.getMessage
        .mockResolvedValueOnce(makeGenieMessage({ status: "EXECUTING_QUERY" }))
        .mockResolvedValueOnce(makeGenieMessage({ status: "COMPLETED" }));

      const events = await collect(
        connector.streamGetMessage(ws, "space-1", "conv-1", "msg-1", {
          pollInterval: 0,
        }),
      );

      expect(events[0]).toEqual({
        type: "status",
        status: "EXECUTING_QUERY",
      });
      expect(events[1]).toEqual({ type: "status", status: "COMPLETED" });
      expect(events[2]).toMatchObject({ type: "message_result" });
      expect(ws.genie.getMessage).toHaveBeenCalledTimes(2);
    });

    test("polls until FAILED, yields status + message_result", async () => {
      ws.genie.getMessage
        .mockResolvedValueOnce(makeGenieMessage({ status: "EXECUTING_QUERY" }))
        .mockResolvedValueOnce(
          makeGenieMessage({
            status: "FAILED",
            error: { error: "query timed out" },
          }),
        );

      const events = await collect(
        connector.streamGetMessage(ws, "space-1", "conv-1", "msg-1", {
          pollInterval: 0,
        }),
      );

      const statusEvents = events.filter((e) => e.type === "status");
      expect(statusEvents).toEqual([
        { type: "status", status: "EXECUTING_QUERY" },
        { type: "status", status: "FAILED" },
      ]);

      const msgResult = events.find((e) => e.type === "message_result") as any;
      expect(msgResult.message.status).toBe("FAILED");
      expect(msgResult.message.error).toBe("query timed out");
    });

    test("respects abort signal", async () => {
      const controller = new AbortController();

      ws.genie.getMessage.mockResolvedValue(
        makeGenieMessage({ status: "EXECUTING_QUERY" }),
      );

      const gen = connector.streamGetMessage(ws, "space-1", "conv-1", "msg-1", {
        pollInterval: 50,
        signal: controller.signal,
      });

      const events: GenieStreamEvent[] = [];
      // Collect the first status event, then abort
      for await (const event of gen) {
        events.push(event);
        if (events.length === 1) {
          controller.abort();
        }
      }

      // Should have stopped after abort - at most 2 events
      // (the status from poll 1, and possibly status from poll 2 that was already in-flight)
      expect(events.length).toBeLessThanOrEqual(2);
      expect(events[0]).toEqual({
        type: "status",
        status: "EXECUTING_QUERY",
      });
    });

    test("yields error when getMessage throws", async () => {
      ws.genie.getMessage.mockRejectedValue(new Error("service unavailable"));

      const events = await collect(
        connector.streamGetMessage(ws, "space-1", "conv-1", "msg-1", {
          pollInterval: 0,
        }),
      );

      expect(events).toEqual([{ type: "error", error: "service unavailable" }]);
    });

    test("does not duplicate status events for same status", async () => {
      ws.genie.getMessage
        .mockResolvedValueOnce(makeGenieMessage({ status: "EXECUTING_QUERY" }))
        .mockResolvedValueOnce(makeGenieMessage({ status: "EXECUTING_QUERY" }))
        .mockResolvedValueOnce(makeGenieMessage({ status: "COMPLETED" }));

      const events = await collect(
        connector.streamGetMessage(ws, "space-1", "conv-1", "msg-1", {
          pollInterval: 0,
        }),
      );

      const statusEvents = events.filter((e) => e.type === "status");
      expect(statusEvents).toEqual([
        { type: "status", status: "EXECUTING_QUERY" },
        { type: "status", status: "COMPLETED" },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // sendMessage
  // -----------------------------------------------------------------------

  describe("sendMessage", () => {
    test("returns completed message response", async () => {
      const completedMsg = makeGenieMessage({
        message_id: "msg-42",
        conversation_id: "conv-new",
      });
      const waiter = createMockWaiter({ result: completedMsg });
      ws.genie.startConversation.mockResolvedValue(waiter);

      const result = await connector.sendMessage(
        ws,
        "space-1",
        "What are sales?",
        undefined,
      );

      expect(result.messageId).toBe("msg-42");
      expect(result.conversationId).toBe("conv-new");
      expect(result.status).toBe("COMPLETED");
    });
  });

  // -----------------------------------------------------------------------
  // getConversation
  // -----------------------------------------------------------------------

  describe("getConversation", () => {
    test("paginates through all pages", async () => {
      // listConversationMessages reverses the SDK response, so mock data
      // is ordered newest-first (as the SDK returns) and results are
      // oldest-first after reversal.
      ws.genie.listConversationMessages
        .mockResolvedValueOnce({
          messages: [
            makeGenieMessage({ message_id: "m2" }),
            makeGenieMessage({ message_id: "m1" }),
          ],
          next_page_token: "page2",
        })
        .mockResolvedValueOnce({
          messages: [makeGenieMessage({ message_id: "m3" })],
          next_page_token: null,
        });

      const result = await connector.getConversation(ws, "space-1", "conv-1");

      expect(result.messages).toHaveLength(3);
      expect(result.messages.map((m) => m.messageId)).toEqual([
        "m1",
        "m2",
        "m3",
      ]);
      expect(ws.genie.listConversationMessages).toHaveBeenCalledTimes(2);
    });

    test("respects maxMessages limit", async () => {
      const smallConnector = new GenieConnector({
        timeout: 0,
        maxMessages: 2,
      });

      ws.genie.listConversationMessages.mockResolvedValueOnce({
        messages: [
          makeGenieMessage({ message_id: "m1" }),
          makeGenieMessage({ message_id: "m2" }),
          makeGenieMessage({ message_id: "m3" }),
        ],
        next_page_token: "page2",
      });

      const result = await smallConnector.getConversation(
        ws,
        "space-1",
        "conv-1",
      );

      // Should be sliced to maxMessages
      expect(result.messages).toHaveLength(2);
      // Should NOT fetch a second page since length already >= maxMessages
      expect(ws.genie.listConversationMessages).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // mapAttachments (tested indirectly via toMessageResponse)
  // -----------------------------------------------------------------------

  describe("mapAttachments", () => {
    test("handles query attachments", async () => {
      const msg = makeGenieMessageWithQuery();
      const waiter = createMockWaiter({ result: msg });
      ws.genie.startConversation.mockResolvedValue(waiter);

      // We drive through streamSendMessage to exercise mapAttachments
      ws.genie.getMessageAttachmentQueryResult.mockResolvedValue({
        statement_response: {
          manifest: { schema: { columns: [] } },
          result: { data_array: [] },
        },
      });

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "q", undefined),
      );

      const msgResult = events.find((e) => e.type === "message_result") as any;
      expect(msgResult.message.attachments[0]).toEqual({
        attachmentId: "att-1",
        query: {
          title: "Sales Query",
          description: "Total sales",
          query: "SELECT sum(amount) FROM sales",
          statementId: "stmt-1",
        },
        text: undefined,
        suggestedQuestions: undefined,
      });
    });

    test("handles text attachments", async () => {
      const msg = makeGenieMessage({
        attachments: [
          {
            attachment_id: "att-text",
            text: { content: "Here is the explanation" },
          },
        ],
      });
      const waiter = createMockWaiter({ result: msg });
      ws.genie.startConversation.mockResolvedValue(waiter);

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "q", undefined),
      );

      const msgResult = events.find((e) => e.type === "message_result") as any;
      expect(msgResult.message.attachments[0]).toEqual({
        attachmentId: "att-text",
        query: undefined,
        text: { content: "Here is the explanation" },
        suggestedQuestions: undefined,
      });
    });

    test("handles suggestedQuestions attachments", async () => {
      const msg = makeGenieMessage({
        attachments: [
          {
            attachment_id: "att-sq",
            suggested_questions: {
              questions: ["What is X?", "Show me Y"],
            },
          },
        ],
      });
      const waiter = createMockWaiter({ result: msg });
      ws.genie.startConversation.mockResolvedValue(waiter);

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "q", undefined),
      );

      const msgResult = events.find((e) => e.type === "message_result") as any;
      expect(msgResult.message.attachments[0]).toEqual({
        attachmentId: "att-sq",
        query: undefined,
        text: undefined,
        suggestedQuestions: ["What is X?", "Show me Y"],
      });
    });

    test("returns empty array when message has no attachments", async () => {
      const msg = makeGenieMessage({ attachments: undefined });
      const waiter = createMockWaiter({ result: msg });
      ws.genie.startConversation.mockResolvedValue(waiter);

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "q", undefined),
      );

      const msgResult = events.find((e) => e.type === "message_result") as any;
      expect(msgResult.message.attachments).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // classifyGenieError (tested indirectly via error events)
  // -----------------------------------------------------------------------

  describe("classifyGenieError", () => {
    test("maps RESOURCE_DOES_NOT_EXIST to space access denied", async () => {
      ws.genie.startConversation.mockRejectedValue(
        new Error("RESOURCE_DOES_NOT_EXIST: space xyz"),
      );

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "hi", undefined),
      );

      expect(events[0]).toEqual({
        type: "error",
        error: "You don't have access to this Genie Space.",
      });
    });

    test("maps failed-to-reach-COMPLETED + FAILED to table permissions", async () => {
      ws.genie.startConversation.mockRejectedValue(
        new Error("failed to reach COMPLETED state, got FAILED"),
      );

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "hi", undefined),
      );

      expect(events[0]).toEqual({
        type: "error",
        error:
          "You may not have access to the data tables. Please verify your table permissions.",
      });
    });

    test("passes through unknown error messages", async () => {
      ws.genie.startConversation.mockRejectedValue(
        new Error("something unexpected"),
      );

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "hi", undefined),
      );

      expect(events[0]).toEqual({
        type: "error",
        error: "something unexpected",
      });
    });

    test("handles non-Error throwable", async () => {
      ws.genie.startConversation.mockRejectedValue("string error");

      const events = await collect(
        connector.streamSendMessage(ws, "space-1", "hi", undefined),
      );

      expect(events[0]).toEqual({
        type: "error",
        error: "string error",
      });
    });
  });
});
