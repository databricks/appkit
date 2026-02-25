import { Time, TimeUnits } from "@databricks/sdk-experimental";
import type {
  GenieMessage,
  GenieStartConversationResponse,
} from "@databricks/sdk-experimental/dist/apis/dashboards";
import type { Waiter } from "@databricks/sdk-experimental/dist/wait";
import type express from "express";
import type { IAppRouter, StreamExecutionSettings } from "shared";
import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging";
import { Plugin, toPlugin } from "../../plugin";
import { genieStreamDefaults } from "./defaults";
import { genieManifest } from "./manifest";
import type {
  GenieAttachmentResponse,
  GenieConversationHistoryResponse,
  GenieMessageResponse,
  GenieSendMessageRequest,
  GenieStreamEvent,
  IGenieConfig,
} from "./types";

const logger = createLogger("genie");

type StartConversationWaiter = Waiter<
  GenieStartConversationResponse,
  GenieMessage
>;
type CreateMessageWaiter = Waiter<GenieMessage, GenieMessage>;

/** Extract our cleaned attachment response from a raw SDK GenieMessage */
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

/** Build a GenieMessageResponse from a raw SDK GenieMessage */
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

export class GeniePlugin extends Plugin {
  name = "genie";

  static manifest = genieManifest;

  protected static description =
    "AI/BI Genie space integration for natural language data queries";
  protected declare config: IGenieConfig;

  constructor(config: IGenieConfig) {
    super(config);
    this.config = config;
  }

  private resolveSpaceId(alias: string): string | null {
    return this.config.spaces?.[alias] ?? null;
  }

  injectRoutes(router: IAppRouter) {
    this.route(router, {
      name: "sendMessage",
      method: "post",
      path: "/:alias/messages",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleSendMessage(req, res);
      },
    });

    this.route(router, {
      name: "getConversation",
      method: "get",
      path: "/:alias/conversations/:conversationId",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleGetConversation(req, res);
      },
    });
  }

  async _handleSendMessage(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { alias } = req.params;
    const spaceId = this.resolveSpaceId(alias);

    if (!spaceId) {
      res.status(404).json({ error: `Unknown space alias: ${alias}` });
      return;
    }

    const { content, conversationId } = req.body as GenieSendMessageRequest;

    if (!content) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    logger.debug(
      "Sending message to space %s (alias=%s, conversationId=%s)",
      spaceId,
      alias,
      conversationId ?? "new",
    );

    const timeout = this.config.timeout ?? 120_000;

    const streamSettings: StreamExecutionSettings = {
      ...genieStreamDefaults,
      default: {
        ...genieStreamDefaults.default,
        // timeout: 0 means indefinite (no TimeoutInterceptor)
        timeout,
      },
    };

    await this.executeStream<GenieStreamEvent>(
      res,
      async function* () {
        const workspaceClient = getWorkspaceClient();

        try {
          // Status events queue bridging onProgress → generator
          const statusQueue: string[] = [];
          let notifyGenerator: () => void = () => {};
          let waiterDone = false;

          const onProgress = async (message: GenieMessage): Promise<void> => {
            if (message.status) {
              statusQueue.push(message.status);
              notifyGenerator();
            }
          };

          let resultConversationId = "";
          let resultMessageId = "";
          let completedMessage: GenieMessage =
            undefined as unknown as GenieMessage;
          let waiterError: Error | null = null;

          // Launch Genie API call
          const waiterPromise = (async () => {
            let messageWaiter: CreateMessageWaiter;

            if (conversationId) {
              messageWaiter = await workspaceClient.genie.createMessage({
                space_id: spaceId,
                conversation_id: conversationId,
                content,
              });
              resultConversationId = conversationId;
            } else {
              const startWaiter: StartConversationWaiter =
                await workspaceClient.genie.startConversation({
                  space_id: spaceId,
                  content,
                });
              resultConversationId = startWaiter.conversation_id;
              resultMessageId = startWaiter.message_id;
              messageWaiter = startWaiter as unknown as CreateMessageWaiter;
            }

            const result = await messageWaiter.wait({ onProgress });
            completedMessage = result;
            resultMessageId = result.message_id;
            return result;
          })()
            .catch((err: Error) => {
              waiterError = err;
            })
            .finally(() => {
              waiterDone = true;
              notifyGenerator();
            });

          // Wait for first status or waiter completion to get IDs
          await new Promise<void>((resolve) => {
            notifyGenerator = resolve;
            if (waiterDone) resolve();
          });

          // If the API call failed before anything started, yield error and exit
          if (waiterError) {
            throw waiterError;
          }

          // Yield message_start
          yield {
            type: "message_start" as const,
            conversationId: resultConversationId,
            messageId: resultMessageId,
            spaceId,
          };

          // Drain status events
          while (!waiterDone || statusQueue.length > 0) {
            while (statusQueue.length > 0) {
              const status = statusQueue.shift();
              if (status) {
                yield { type: "status" as const, status };
              }
            }

            if (!waiterDone) {
              await new Promise<void>((resolve) => {
                notifyGenerator = resolve;
                if (waiterDone) resolve();
              });
            }
          }

          // Check if waiter failed during polling
          await waiterPromise;
          if (waiterError) {
            throw waiterError;
          }

          // Build cleaned message response
          const messageResponse = toMessageResponse(completedMessage);

          yield {
            type: "message_result" as const,
            message: messageResponse,
          };

          // Fetch query results for each query attachment
          const attachments = messageResponse.attachments ?? [];
          for (const att of attachments) {
            if (att.query?.statementId && att.attachmentId) {
              try {
                const queryResult =
                  await workspaceClient.genie.getMessageAttachmentQueryResult({
                    space_id: spaceId,
                    conversation_id: resultConversationId,
                    message_id: resultMessageId,
                    attachment_id: att.attachmentId,
                  });

                yield {
                  type: "query_result" as const,
                  attachmentId: att.attachmentId,
                  statementId: att.query.statementId,
                  data: queryResult.statement_response,
                };
              } catch (error) {
                logger.error(
                  "Failed to fetch query result for attachment %s: %O",
                  att.attachmentId,
                  error,
                );
                yield {
                  type: "error" as const,
                  error: `Failed to fetch query result for attachment ${att.attachmentId}`,
                };
              }
            }
          }
        } catch (error) {
          logger.error("Genie message error: %O", error);
          yield {
            type: "error" as const,
            error:
              error instanceof Error ? error.message : "Genie request failed",
          };
        }
      },
      streamSettings,
    );
  }

  private async _fetchAllMessages(
    spaceId: string,
    conversationId: string,
  ): Promise<GenieMessage[]> {
    const workspaceClient = getWorkspaceClient();
    const allMessages: GenieMessage[] = [];
    let pageToken: string | undefined;
    const maxMessages = 200;

    do {
      const response = await workspaceClient.genie.listConversationMessages({
        space_id: spaceId,
        conversation_id: conversationId,
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      });

      if (response.messages) {
        allMessages.push(...response.messages);
      }

      pageToken = response.next_page_token;
    } while (pageToken && allMessages.length < maxMessages);

    return allMessages.slice(0, maxMessages);
  }

  async _handleGetConversation(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { alias, conversationId } = req.params;
    const spaceId = this.resolveSpaceId(alias);

    if (!spaceId) {
      res.status(404).json({ error: `Unknown space alias: ${alias}` });
      return;
    }

    const includeQueryResults = req.query.includeQueryResults !== "false";

    logger.debug(
      "Fetching conversation %s from space %s (alias=%s, includeQueryResults=%s)",
      conversationId,
      spaceId,
      alias,
      includeQueryResults,
    );

    const self = this;

    await this.executeStream<GenieStreamEvent>(
      res,
      async function* () {
        try {
          const messages = await self._fetchAllMessages(
            spaceId,
            conversationId,
          );

          const messageResponses: GenieMessageResponse[] = [];

          for (const message of messages) {
            const messageResponse = toMessageResponse(message);
            messageResponses.push(messageResponse);

            yield {
              type: "message_result" as const,
              message: messageResponse,
            };
          }

          if (includeQueryResults) {
            // Collect all query attachments across all messages
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

            // Fetch all query results in parallel
            const workspaceClient = getWorkspaceClient();
            const results = await Promise.allSettled(
              queryAttachments.map(async (att) => {
                const queryResult =
                  await workspaceClient.genie.getMessageAttachmentQueryResult({
                    space_id: spaceId,
                    conversation_id: conversationId,
                    message_id: att.messageId,
                    attachment_id: att.attachmentId,
                  });
                return {
                  attachmentId: att.attachmentId,
                  statementId: att.statementId,
                  data: queryResult.statement_response,
                };
              }),
            );

            for (const result of results) {
              if (result.status === "fulfilled") {
                yield {
                  type: "query_result" as const,
                  attachmentId: result.value.attachmentId,
                  statementId: result.value.statementId,
                  data: result.value.data,
                };
              } else {
                logger.error("Failed to fetch query result: %O", result.reason);
                yield {
                  type: "error" as const,
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
            type: "error" as const,
            error:
              error instanceof Error
                ? error.message
                : "Failed to fetch conversation",
          };
        }
      },
      genieStreamDefaults,
    );
  }

  async getConversation(
    alias: string,
    conversationId: string,
  ): Promise<GenieConversationHistoryResponse> {
    const spaceId = this.resolveSpaceId(alias);
    if (!spaceId) {
      throw new Error(`Unknown space alias: ${alias}`);
    }

    const messages = await this._fetchAllMessages(spaceId, conversationId);

    return {
      conversationId,
      spaceId,
      messages: messages.map(toMessageResponse),
    };
  }

  async sendMessage(
    alias: string,
    content: string,
    conversationId?: string,
  ): Promise<GenieMessageResponse> {
    const spaceId = this.resolveSpaceId(alias);
    if (!spaceId) {
      throw new Error(`Unknown space alias: ${alias}`);
    }

    const workspaceClient = getWorkspaceClient();
    const timeout = this.config.timeout ?? 120_000;

    let messageWaiter: CreateMessageWaiter;
    let resultConversationId: string;

    if (conversationId) {
      messageWaiter = await workspaceClient.genie.createMessage({
        space_id: spaceId,
        conversation_id: conversationId,
        content,
      });
      resultConversationId = conversationId;
    } else {
      const startWaiter: StartConversationWaiter =
        await workspaceClient.genie.startConversation({
          space_id: spaceId,
          content,
        });
      resultConversationId = startWaiter.conversation_id;
      messageWaiter = startWaiter as unknown as CreateMessageWaiter;
    }

    const waitOptions =
      timeout > 0 ? { timeout: new Time(timeout, TimeUnits.milliseconds) } : {};
    const completedMessage = await messageWaiter.wait(waitOptions);

    return {
      ...toMessageResponse(completedMessage),
      conversationId: resultConversationId,
    };
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    return {
      sendMessage: this.sendMessage,
      getConversation: this.getConversation,
    };
  }
}

/**
 * @internal
 */
export const genie = toPlugin<typeof GeniePlugin, IGenieConfig, "genie">(
  GeniePlugin,
  "genie",
);
