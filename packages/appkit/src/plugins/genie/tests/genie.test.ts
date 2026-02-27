import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { Plugin } from "../../../plugin";
import { GeniePlugin, genie } from "../genie";
import type { IGenieConfig } from "../types";

// Mock CacheManager singleton
const { mockCacheInstance } = vi.hoisted(() => {
  const instance = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi
      .fn()
      .mockImplementation(
        async (_key: unknown[], fn: () => Promise<unknown>) => {
          return await fn();
        },
      ),
    generateKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  };

  return { mockCacheInstance: instance };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

function createMockGenieService() {
  const getMessageAttachmentQueryResult = vi.fn();

  const createWaiter = (
    conversationId: string,
    messageId: string,
    attachments: any[] = [],
    status = "COMPLETED",
  ) => ({
    wait: vi.fn().mockImplementation(async ({ onProgress }: any) => {
      if (onProgress) {
        await onProgress({ status: "ASKING_AI" });
        await onProgress({ status: "EXECUTING_QUERY" });
      }
      return {
        message_id: messageId,
        conversation_id: conversationId,
        space_id: "test-space-id",
        content: "Here are your results",
        status,
        attachments,
        error: undefined,
      };
    }),
  });

  const startConversation = vi.fn().mockImplementation(async () => ({
    conversation_id: "new-conv-id",
    message_id: "new-msg-id",
    ...createWaiter("new-conv-id", "new-msg-id", [
      {
        attachment_id: "att-1",
        query: {
          title: "Top Customers",
          description: "Query for top customers",
          query: "SELECT * FROM customers",
          statement_id: "stmt-1",
        },
      },
    ]),
  }));

  const createMessage = vi.fn().mockImplementation(async () =>
    createWaiter("existing-conv-id", "followup-msg-id", [
      {
        attachment_id: "att-2",
        query: {
          title: "Follow-up Query",
          query: "SELECT * FROM orders",
          statement_id: "stmt-2",
        },
      },
    ]),
  );

  const listConversationMessages = vi.fn();

  return {
    startConversation,
    createMessage,
    getMessageAttachmentQueryResult,
    listConversationMessages,
    createWaiter,
  };
}

describe("Genie Plugin", () => {
  let config: IGenieConfig;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  let mockGenieService: ReturnType<typeof createMockGenieService>;

  beforeEach(async () => {
    config = {
      spaces: {
        myspace: "test-space-id",
        salesbot: "sales-space-id",
      },
      timeout: 5000,
    };
    setupDatabricksEnv();
    ServiceContext.reset();

    mockGenieService = createMockGenieService();

    mockGenieService.getMessageAttachmentQueryResult.mockResolvedValue({
      statement_response: {
        status: { state: "SUCCEEDED" },
        result: {
          data_array: [
            ["Acme Corp", "1000000"],
            ["Globex", "500000"],
          ],
        },
        manifest: {
          schema: {
            columns: [
              { name: "customer", type_name: "STRING" },
              { name: "revenue", type_name: "DECIMAL" },
            ],
          },
        },
      },
    });

    serviceContextMock = await mockServiceContext({
      userDatabricksClient: {
        genie: mockGenieService,
      },
    });
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  test("genie factory should have correct name", () => {
    const pluginData = genie({ spaces: { test: "id" } });
    expect(pluginData.name).toBe("genie");
  });

  test("plugin instance should be created with correct name", () => {
    const plugin = new GeniePlugin(config);
    expect(plugin.name).toBe("genie");
  });

  describe("injectRoutes", () => {
    test("should register POST and GET routes", () => {
      const plugin = new GeniePlugin(config);
      const { router } = createMockRouter();

      plugin.injectRoutes(router);

      expect(router.post).toHaveBeenCalledTimes(1);
      expect(router.post).toHaveBeenCalledWith(
        "/:alias/messages",
        expect.any(Function),
      );

      expect(router.get).toHaveBeenCalledTimes(1);
      expect(router.get).toHaveBeenCalledWith(
        "/:alias/conversations/:conversationId",
        expect.any(Function),
      );
    });
  });

  describe("space alias resolution", () => {
    test("should return 404 for unknown alias", async () => {
      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "unknown" },
        body: { content: "test question" },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Unknown space alias: unknown",
      });
    });

    test("should resolve valid alias", async () => {
      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "myspace" },
        body: { content: "What are my top customers?" },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(404);
      expect(mockGenieService.startConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: "test-space-id",
          content: "What are my top customers?",
        }),
      );
    });
  });

  describe("validation", () => {
    test("should return 400 when content is missing", async () => {
      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "myspace" },
        body: {},
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "content is required",
      });
    });
  });

  describe("send message - new conversation", () => {
    test("should call startConversation and stream SSE events", async () => {
      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "myspace" },
        body: { content: "What are my top customers?" },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockGenieService.startConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: "test-space-id",
          content: "What are my top customers?",
        }),
      );

      // Verify SSE headers
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream",
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        "Cache-Control",
        "no-cache",
      );

      // Verify SSE events are written
      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      // Should have message_start event
      expect(allWritten).toContain("message_start");
      expect(allWritten).toContain("new-conv-id");

      // Should have status events
      expect(allWritten).toContain("status");
      expect(allWritten).toContain("ASKING_AI");

      // Should have message_result event
      expect(allWritten).toContain("message_result");

      // Should have query_result event
      expect(allWritten).toContain("query_result");

      expect(mockRes.end).toHaveBeenCalled();
    });
  });

  describe("send message - follow-up", () => {
    test("should call createMessage with conversationId", async () => {
      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "myspace" },
        body: {
          content: "Show me more details",
          conversationId: "existing-conv-id",
        },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockGenieService.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: "test-space-id",
          conversation_id: "existing-conv-id",
          content: "Show me more details",
        }),
      );

      expect(mockGenieService.startConversation).not.toHaveBeenCalled();

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      expect(allWritten).toContain("message_start");
      expect(allWritten).toContain("existing-conv-id");
      expect(mockRes.end).toHaveBeenCalled();
    });
  });

  describe("multiple attachments", () => {
    test("should yield query_result for each query attachment", async () => {
      // Override startConversation to return multiple query attachments
      mockGenieService.startConversation.mockImplementation(async () => ({
        conversation_id: "multi-conv-id",
        message_id: "multi-msg-id",
        wait: vi.fn().mockImplementation(async ({ onProgress }: any) => {
          if (onProgress) {
            await onProgress({ status: "ASKING_AI" });
          }
          return {
            message_id: "multi-msg-id",
            conversation_id: "multi-conv-id",
            space_id: "test-space-id",
            content: "Here are two queries",
            status: "COMPLETED",
            attachments: [
              {
                attachment_id: "att-q1",
                query: {
                  title: "Query 1",
                  query: "SELECT 1",
                  statement_id: "stmt-q1",
                },
              },
              {
                attachment_id: "att-q2",
                query: {
                  title: "Query 2",
                  query: "SELECT 2",
                  statement_id: "stmt-q2",
                },
              },
              {
                attachment_id: "att-text",
                text: { content: "Some explanation" },
              },
            ],
          };
        }),
      }));

      mockGenieService.getMessageAttachmentQueryResult
        .mockResolvedValueOnce({
          statement_response: { result: { data: [["row1"]] } },
        })
        .mockResolvedValueOnce({
          statement_response: { result: { data: [["row2"]] } },
        });

      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "myspace" },
        body: { content: "Run two queries" },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      // getMessageAttachmentQueryResult should be called twice (once per query attachment)
      expect(
        mockGenieService.getMessageAttachmentQueryResult,
      ).toHaveBeenCalledTimes(2);

      expect(
        mockGenieService.getMessageAttachmentQueryResult,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ attachment_id: "att-q1" }),
      );
      expect(
        mockGenieService.getMessageAttachmentQueryResult,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ attachment_id: "att-q2" }),
      );

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      // Should have two query_result events
      const queryResultCount = (allWritten.match(/query_result/g) || []).length;
      expect(queryResultCount).toBeGreaterThanOrEqual(2);

      expect(mockRes.end).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    test("should yield error event on SDK failure", async () => {
      mockGenieService.startConversation.mockRejectedValue(
        new Error("Genie service unavailable"),
      );

      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "myspace" },
        body: { content: "test question" },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      expect(allWritten).toContain("error");
      expect(allWritten).toContain("Genie service unavailable");

      expect(mockRes.end).toHaveBeenCalled();
    });
  });

  describe("getConversation", () => {
    function createConversationRequest(overrides: Record<string, any> = {}) {
      return createMockRequest({
        params: { alias: "myspace", conversationId: "conv-123" },
        query: {},
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
        ...overrides,
      });
    }

    function mockMessages(messages: any[]) {
      mockGenieService.listConversationMessages.mockResolvedValue({
        messages,
        next_page_token: undefined,
      });
    }

    test("should return 404 for unknown alias", async () => {
      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler(
        "GET",
        "/:alias/conversations/:conversationId",
      );
      const mockReq = createConversationRequest({
        params: { alias: "unknown", conversationId: "conv-123" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Unknown space alias: unknown",
      });
    });

    test("should stream message_result events for each message", async () => {
      mockMessages([
        {
          message_id: "msg-1",
          conversation_id: "conv-123",
          space_id: "test-space-id",
          content: "What are the top customers?",
          status: "COMPLETED",
          attachments: [],
        },
        {
          message_id: "msg-2",
          conversation_id: "conv-123",
          space_id: "test-space-id",
          content: "Here are the results",
          status: "COMPLETED",
          attachments: [
            {
              attachment_id: "att-1",
              query: {
                title: "Top Customers",
                query: "SELECT * FROM customers",
                statement_id: "stmt-1",
              },
            },
          ],
        },
      ]);

      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler(
        "GET",
        "/:alias/conversations/:conversationId",
      );
      const mockReq = createConversationRequest();
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockGenieService.listConversationMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: "test-space-id",
          conversation_id: "conv-123",
          page_size: 100,
        }),
      );

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      // Should have two message_result events
      const messageResultCount = (
        allWritten.match(/"type":"message_result"/g) || []
      ).length;
      expect(messageResultCount).toBe(2);

      // Should contain message content
      expect(allWritten).toContain("What are the top customers?");
      expect(allWritten).toContain("Here are the results");

      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should stream query_result events when includeQueryResults is true (default)", async () => {
      mockMessages([
        {
          message_id: "msg-1",
          conversation_id: "conv-123",
          space_id: "test-space-id",
          content: "Results",
          status: "COMPLETED",
          attachments: [
            {
              attachment_id: "att-1",
              query: {
                title: "Query 1",
                query: "SELECT 1",
                statement_id: "stmt-1",
              },
            },
          ],
        },
      ]);

      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler(
        "GET",
        "/:alias/conversations/:conversationId",
      );
      const mockReq = createConversationRequest();
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(
        mockGenieService.getMessageAttachmentQueryResult,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: "test-space-id",
          conversation_id: "conv-123",
          message_id: "msg-1",
          attachment_id: "att-1",
        }),
      );

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      expect(allWritten).toContain("message_result");
      expect(allWritten).toContain("query_result");
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should NOT stream query_result events when includeQueryResults is false", async () => {
      mockMessages([
        {
          message_id: "msg-1",
          conversation_id: "conv-123",
          space_id: "test-space-id",
          content: "Results",
          status: "COMPLETED",
          attachments: [
            {
              attachment_id: "att-1",
              query: {
                title: "Query 1",
                query: "SELECT 1",
                statement_id: "stmt-1",
              },
            },
          ],
        },
      ]);

      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler(
        "GET",
        "/:alias/conversations/:conversationId",
      );
      const mockReq = createConversationRequest({
        query: { includeQueryResults: "false" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(
        mockGenieService.getMessageAttachmentQueryResult,
      ).not.toHaveBeenCalled();

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      expect(allWritten).toContain("message_result");
      expect(allWritten).not.toContain("query_result");
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should paginate through all messages", async () => {
      mockGenieService.listConversationMessages
        .mockResolvedValueOnce({
          messages: [
            {
              message_id: "msg-1",
              conversation_id: "conv-123",
              space_id: "test-space-id",
              content: "Page 1 message",
              status: "COMPLETED",
              attachments: [],
            },
          ],
          next_page_token: "page-2-token",
        })
        .mockResolvedValueOnce({
          messages: [
            {
              message_id: "msg-2",
              conversation_id: "conv-123",
              space_id: "test-space-id",
              content: "Page 2 message",
              status: "COMPLETED",
              attachments: [],
            },
          ],
          next_page_token: undefined,
        });

      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler(
        "GET",
        "/:alias/conversations/:conversationId",
      );
      const mockReq = createConversationRequest({
        query: { includeQueryResults: "false" },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockGenieService.listConversationMessages).toHaveBeenCalledTimes(
        2,
      );

      // First call without page_token
      expect(mockGenieService.listConversationMessages).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          space_id: "test-space-id",
          conversation_id: "conv-123",
          page_size: 100,
        }),
      );

      // Second call with page_token
      expect(mockGenieService.listConversationMessages).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          space_id: "test-space-id",
          conversation_id: "conv-123",
          page_size: 100,
          page_token: "page-2-token",
        }),
      );

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      expect(allWritten).toContain("Page 1 message");
      expect(allWritten).toContain("Page 2 message");
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should handle empty conversation", async () => {
      mockMessages([]);

      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler(
        "GET",
        "/:alias/conversations/:conversationId",
      );
      const mockReq = createConversationRequest();
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      expect(allWritten).not.toContain("message_result");
      expect(allWritten).not.toContain("query_result");
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should yield error event on SDK failure", async () => {
      mockGenieService.listConversationMessages.mockRejectedValue(
        new Error("Conversation not found"),
      );

      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler(
        "GET",
        "/:alias/conversations/:conversationId",
      );
      const mockReq = createConversationRequest();
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      expect(allWritten).toContain("error");
      expect(allWritten).toContain("Conversation not found");
      expect(mockRes.end).toHaveBeenCalled();
    });

    test("should fetch query results in parallel for multiple attachments across messages", async () => {
      mockMessages([
        {
          message_id: "msg-1",
          conversation_id: "conv-123",
          space_id: "test-space-id",
          content: "First query",
          status: "COMPLETED",
          attachments: [
            {
              attachment_id: "att-1",
              query: {
                title: "Query 1",
                query: "SELECT 1",
                statement_id: "stmt-1",
              },
            },
          ],
        },
        {
          message_id: "msg-2",
          conversation_id: "conv-123",
          space_id: "test-space-id",
          content: "Second query",
          status: "COMPLETED",
          attachments: [
            {
              attachment_id: "att-2",
              query: {
                title: "Query 2",
                query: "SELECT 2",
                statement_id: "stmt-2",
              },
            },
          ],
        },
      ]);

      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler(
        "GET",
        "/:alias/conversations/:conversationId",
      );
      const mockReq = createConversationRequest();
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(
        mockGenieService.getMessageAttachmentQueryResult,
      ).toHaveBeenCalledTimes(2);

      expect(
        mockGenieService.getMessageAttachmentQueryResult,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          message_id: "msg-1",
          attachment_id: "att-1",
        }),
      );
      expect(
        mockGenieService.getMessageAttachmentQueryResult,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          message_id: "msg-2",
          attachment_id: "att-2",
        }),
      );

      const writeCalls = mockRes.write.mock.calls.map((call: any[]) => call[0]);
      const allWritten = writeCalls.join("");

      const queryResultCount = (
        allWritten.match(/"type":"query_result"/g) || []
      ).length;
      expect(queryResultCount).toBe(2);
      expect(mockRes.end).toHaveBeenCalled();
    });
  });

  describe("default spaces from DATABRICKS_GENIE_SPACE_ID", () => {
    test("should use env var as default space when spaces is omitted", async () => {
      process.env.DATABRICKS_GENIE_SPACE_ID = "env-space-id";

      const plugin = new GeniePlugin({ timeout: 5000 });
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "default" },
        body: { content: "test question" },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(404);
      expect(mockGenieService.startConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: "env-space-id",
          content: "test question",
        }),
      );

      delete process.env.DATABRICKS_GENIE_SPACE_ID;
    });

    test("should 404 for any alias when spaces is omitted and env var is unset", async () => {
      delete process.env.DATABRICKS_GENIE_SPACE_ID;

      const plugin = new GeniePlugin({ timeout: 5000 });
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "default" },
        body: { content: "test question" },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Unknown space alias: default",
      });
    });
  });

  describe("SSE reconnection streamId", () => {
    let executeStreamSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      executeStreamSpy = vi.spyOn(Plugin.prototype as any, "executeStream");
      executeStreamSpy.mockResolvedValue(undefined);
    });

    afterEach(() => {
      executeStreamSpy.mockRestore();
    });

    test("sendMessage should use requestId query param as streamId", async () => {
      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "myspace" },
        query: { requestId: "req-uuid-123" },
        body: {
          content: "follow-up question",
          conversationId: "conv-42",
        },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(executeStreamSpy).toHaveBeenCalledWith(
        mockRes,
        expect.any(Function),
        expect.objectContaining({
          stream: expect.objectContaining({
            streamId: "req-uuid-123",
            bufferSize: 100,
          }),
        }),
      );
    });

    test("sendMessage without requestId should generate a random streamId", async () => {
      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler("POST", "/:alias/messages");
      const mockReq = createMockRequest({
        params: { alias: "myspace" },
        body: { content: "new question" },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(executeStreamSpy).toHaveBeenCalledWith(
        mockRes,
        expect.any(Function),
        expect.objectContaining({
          stream: expect.objectContaining({
            streamId: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            ),
            bufferSize: 100,
          }),
        }),
      );
    });

    test("getConversation should use requestId query param as streamId", async () => {
      const plugin = new GeniePlugin(config);
      const { router, getHandler } = createMockRouter();

      plugin.injectRoutes(router);

      const handler = getHandler(
        "GET",
        "/:alias/conversations/:conversationId",
      );
      const mockReq = createMockRequest({
        params: { alias: "myspace", conversationId: "conv-99" },
        query: { requestId: "req-uuid-456" },
        headers: {
          "x-forwarded-access-token": "user-token",
          "x-forwarded-user": "user-1",
        },
      });
      const mockRes = createMockResponse();

      await handler(mockReq, mockRes);

      expect(executeStreamSpy).toHaveBeenCalledWith(
        mockRes,
        expect.any(Function),
        expect.objectContaining({
          stream: expect.objectContaining({
            streamId: "req-uuid-456",
            bufferSize: 100,
          }),
        }),
      );
    });
  });
});
