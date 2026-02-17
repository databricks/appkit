import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
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

  return {
    startConversation,
    createMessage,
    getMessageAttachmentQueryResult,
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
    test("should register single POST route", () => {
      const plugin = new GeniePlugin(config);
      const { router } = createMockRouter();

      plugin.injectRoutes(router);

      expect(router.post).toHaveBeenCalledTimes(1);
      expect(router.post).toHaveBeenCalledWith(
        "/:alias/messages",
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
});
