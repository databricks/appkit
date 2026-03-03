import type { WorkspaceClient } from "@databricks/sdk-experimental";
import * as SDK from "@databricks/sdk-experimental";
import type { GenieMessage } from "@databricks/sdk-experimental/dist/apis/dashboards";
import type { Waiter } from "@databricks/sdk-experimental/dist/wait";
import { createLogger } from "../../logging";
import { genieConnectorDefaults } from "./defaults";
import { pollWaiter } from "./poll-waiter";
import type {
  GenieAttachmentResponse,
  GenieConversationHistoryResponse,
  GenieMessageResponse,
  GenieStreamEvent,
} from "./types";

const { Time, TimeUnits } = SDK;
const logger = createLogger("connectors:genie");

type CreateMessageWaiter = Waiter<GenieMessage, GenieMessage>;

export interface GenieConnectorConfig {
  timeout?: number;
  maxMessages?: number;
}

function mapAttachments(message: GenieMessage): GenieAttachmentResponse[] {
  return (
    message.attachments?.map((att) => ({
      attachmentId: att.attachment_id,
      query: att.query
        ? {
            title: att.query.title,
            description: att.query.description,
            query: att.query.query,
            statementId: att.query.statement_id,
          }
        : undefined,
      text: att.text ? { content: att.text.content } : undefined,
      suggestedQuestions: att.suggested_questions?.questions,
    })) ?? []
  );
}

function toMessageResponse(message: GenieMessage): GenieMessageResponse {
  return {
    messageId: message.message_id,
    conversationId: message.conversation_id,
    spaceId: message.space_id,
    status: message.status ?? "COMPLETED",
    content: message.content,
    attachments: mapAttachments(message),
    error: message.error?.error,
  };
}

export class GenieConnector {
  private readonly config: Required<GenieConnectorConfig>;

  constructor(config: GenieConnectorConfig = {}) {
    this.config = {
      timeout: config.timeout ?? genieConnectorDefaults.timeout,
      maxMessages: config.maxMessages ?? genieConnectorDefaults.maxMessages,
    };
  }

  async startMessage(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    content: string,
    conversationId: string | undefined,
  ): Promise<{
    messageWaiter: CreateMessageWaiter;
    conversationId: string;
    messageId: string;
  }> {
    if (conversationId) {
      const waiter = await workspaceClient.genie.createMessage({
        space_id: spaceId,
        conversation_id: conversationId,
        content,
      });
      return {
        messageWaiter: waiter,
        conversationId,
        messageId: waiter.message_id ?? "",
      };
    }
    const start = await workspaceClient.genie.startConversation({
      space_id: spaceId,
      content,
    });
    return {
      messageWaiter: start as unknown as CreateMessageWaiter,
      conversationId: start.conversation_id,
      messageId: start.message_id,
    };
  }

  async waitForMessage(
    messageWaiter: CreateMessageWaiter,
    options?: { timeout?: number },
  ): Promise<GenieMessage> {
    const timeout = options?.timeout ?? this.config.timeout;
    const waitOptions =
      timeout > 0 ? { timeout: new Time(timeout, TimeUnits.milliseconds) } : {};
    return messageWaiter.wait(waitOptions);
  }

  async listConversationMessages(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    options?: { maxMessages?: number },
  ): Promise<GenieMessageResponse[]> {
    const maxMessages = options?.maxMessages ?? this.config.maxMessages;
    const allMessages: GenieMessage[] = [];
    let pageToken: string | undefined;

    do {
      const response = await workspaceClient.genie.listConversationMessages({
        space_id: spaceId,
        conversation_id: conversationId,
        page_size: genieConnectorDefaults.pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      });

      if (response.messages) {
        allMessages.push(...response.messages);
      }

      pageToken = response.next_page_token;
    } while (pageToken && allMessages.length < maxMessages);

    return allMessages.slice(0, maxMessages).reverse().map(toMessageResponse);
  }

  async getMessageAttachmentQueryResult(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    messageId: string,
    attachmentId: string,
    _signal?: AbortSignal,
  ): Promise<unknown> {
    const response =
      await workspaceClient.genie.getMessageAttachmentQueryResult({
        space_id: spaceId,
        conversation_id: conversationId,
        message_id: messageId,
        attachment_id: attachmentId,
      });
    return response.statement_response;
  }

  async *streamSendMessage(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    content: string,
    conversationId: string | undefined,
    options?: { timeout?: number },
  ): AsyncGenerator<GenieStreamEvent> {
    try {
      const {
        messageWaiter,
        conversationId: resultConversationId,
        messageId: resultMessageId,
      } = await this.startMessage(
        workspaceClient,
        spaceId,
        content,
        conversationId,
      );

      yield {
        type: "message_start",
        conversationId: resultConversationId,
        messageId: resultMessageId,
        spaceId,
      };

      const timeout =
        options?.timeout != null ? options.timeout : this.config.timeout;
      const waitOptions =
        timeout > 0
          ? { timeout: new Time(timeout, TimeUnits.milliseconds) }
          : {};

      let completedMessage!: GenieMessage;
      for await (const event of pollWaiter(messageWaiter, waitOptions)) {
        if (event.type === "progress" && event.value.status) {
          yield { type: "status", status: event.value.status };
        } else if (event.type === "completed") {
          completedMessage = event.value;
        }
      }

      const messageResponse = toMessageResponse(completedMessage);
      yield { type: "message_result", message: messageResponse };

      yield* this.emitQueryResults(
        workspaceClient,
        spaceId,
        resultConversationId,
        messageResponse.messageId,
        messageResponse,
      );
    } catch (error) {
      logger.error("Genie message error: %O", error);
      yield {
        type: "error",
        error: error instanceof Error ? error.message : "Genie request failed",
      };
    }
  }

  private async *emitQueryResults(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    messageId: string,
    messageResponse: GenieMessageResponse,
  ): AsyncGenerator<
    Extract<GenieStreamEvent, { type: "query_result" } | { type: "error" }>
  > {
    const attachments = messageResponse.attachments ?? [];
    for (const att of attachments) {
      if (!att.query?.statementId || !att.attachmentId) continue;
      try {
        const data = await this.getMessageAttachmentQueryResult(
          workspaceClient,
          spaceId,
          conversationId,
          messageId,
          att.attachmentId,
        );
        yield {
          type: "query_result",
          attachmentId: att.attachmentId,
          statementId: att.query.statementId,
          data,
        };
      } catch (error) {
        logger.error(
          "Failed to fetch query result for attachment %s: %O",
          att.attachmentId,
          error,
        );
        yield {
          type: "error",
          error: `Failed to fetch query result for attachment ${att.attachmentId}`,
        };
      }
    }
  }

  async *streamConversation(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    options?: { includeQueryResults?: boolean },
  ): AsyncGenerator<GenieStreamEvent> {
    const includeQueryResults = options?.includeQueryResults !== false;

    try {
      const messageResponses = await this.listConversationMessages(
        workspaceClient,
        spaceId,
        conversationId,
      );

      for (const messageResponse of messageResponses) {
        yield { type: "message_result", message: messageResponse };
      }

      if (includeQueryResults) {
        const queryAttachments: Array<{
          messageId: string;
          attachmentId: string;
          statementId: string;
        }> = [];

        for (const msg of messageResponses) {
          for (const att of msg.attachments ?? []) {
            if (att.query?.statementId && att.attachmentId) {
              queryAttachments.push({
                messageId: msg.messageId,
                attachmentId: att.attachmentId,
                statementId: att.query.statementId,
              });
            }
          }
        }

        const results = await Promise.allSettled(
          queryAttachments.map(async (att) => {
            const data = await this.getMessageAttachmentQueryResult(
              workspaceClient,
              spaceId,
              conversationId,
              att.messageId,
              att.attachmentId,
            );
            return {
              attachmentId: att.attachmentId,
              statementId: att.statementId,
              data,
            };
          }),
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            yield {
              type: "query_result",
              attachmentId: result.value.attachmentId,
              statementId: result.value.statementId,
              data: result.value.data,
            };
          } else {
            logger.error("Failed to fetch query result: %O", result.reason);
            yield {
              type: "error",
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : "Failed to fetch query result",
            };
          }
        }
      }
    } catch (error) {
      logger.error("Genie getConversation error: %O", error);
      yield {
        type: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch conversation",
      };
    }
  }

  async sendMessage(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    content: string,
    conversationId: string | undefined,
  ): Promise<GenieMessageResponse> {
    const { messageWaiter, conversationId: resultConversationId } =
      await this.startMessage(
        workspaceClient,
        spaceId,
        content,
        conversationId,
      );
    const completedMessage = await this.waitForMessage(messageWaiter);
    const messageResponse = toMessageResponse(completedMessage);
    return {
      ...messageResponse,
      conversationId: resultConversationId,
    };
  }

  async getConversation(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
  ): Promise<GenieConversationHistoryResponse> {
    const messages = await this.listConversationMessages(
      workspaceClient,
      spaceId,
      conversationId,
    );
    return {
      conversationId,
      spaceId,
      messages,
    };
  }
}
