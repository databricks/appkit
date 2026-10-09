import { createLogger } from "../../logging";
import type { GenieMessage, WorkspaceClient } from "../../workspace-client";
import { genieConnectorDefaults } from "./defaults";
import { type Pollable, pollWaiter } from "./poll-waiter";
import type {
  GenieAttachmentResponse,
  GenieConversationHistoryResponse,
  GenieMessageResponse,
  GenieStatementResponse,
  GenieStreamEvent,
} from "./types";

const logger = createLogger("connectors:genie");

const GenieErrors = {
  SPACE_ACCESS_DENIED: "You don't have access to this Genie Space.",
  TABLE_PERMISSIONS:
    "You may not have access to the data tables. Please verify your table permissions.",
  REQUEST_FAILED: "Genie request failed",
  QUERY_RESULT_FAILED: "Failed to fetch query result",
} as const;

type CreateMessageWaiter = Pollable<GenieMessage>;

// Legacy SDK waiter defaults, kept so polling cadence is unchanged.
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
const MAX_POLL_INTERVAL_MS = 10_000;

interface GenieConnectorConfig {
  timeout?: number;
  maxMessages?: number;
}

function mapAttachments(message: GenieMessage): GenieAttachmentResponse[] {
  return (
    message.attachments?.map(({ attachmentId, attachment }) => ({
      attachmentId,
      query:
        attachment?.$case === "query"
          ? {
              title: attachment.query.title,
              description: attachment.query.description,
              query: attachment.query.query,
              statementId: attachment.query.statementId,
            }
          : undefined,
      text:
        attachment?.$case === "text"
          ? { content: attachment.text.content }
          : undefined,
      suggestedQuestions:
        attachment?.$case === "suggestedQuestions"
          ? attachment.suggestedQuestions.questions
          : undefined,
    })) ?? []
  );
}

function toMessageResponse(message: GenieMessage): GenieMessageResponse {
  return {
    messageId: message.messageId ?? "",
    conversationId: message.conversationId ?? "",
    spaceId: message.spaceId ?? "",
    status: message.status ?? "COMPLETED",
    content: message.content ?? "",
    attachments: mapAttachments(message),
    error: message.error?.error,
  };
}

/**
 * The modular SDK returns the statement response camelCased, but the SSE
 * contract (`GenieStatementResponse`, read by appkit-ui) is the raw snake_case
 * API shape, so rename keys back here. `bigint` counts are handled by the SSE
 * serializer (`sseJsonReplacer`). Recurses into objects only; `data_array` rows
 * pass through as-is.
 *
 * TODO: update appkit-ui (`genie-query-transform.ts`) and `GenieStatementResponse`
 * to accept the camelCase shape, then drop this conversion (non-breaking path:
 * read both shapes first, switch the server later).
 */
function toWireShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWireShape);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      toWireShape(v),
    ]),
  );
}

function classifyGenieError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Modular ApiError carries the code on `.code`, legacy on `.errorCode`.
  const { code, errorCode } = (error ?? {}) as {
    code?: unknown;
    errorCode?: unknown;
  };

  if (
    code === "RESOURCE_DOES_NOT_EXIST" ||
    errorCode === "RESOURCE_DOES_NOT_EXIST" ||
    message.includes("RESOURCE_DOES_NOT_EXIST")
  ) {
    return GenieErrors.SPACE_ACCESS_DENIED;
  }

  if (
    message.includes("failed to reach COMPLETED state") &&
    message.includes("FAILED")
  ) {
    return GenieErrors.TABLE_PERMISSIONS;
  }

  return message || GenieErrors.REQUEST_FAILED;
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
    const started = conversationId
      ? await workspaceClient.genie.genieCreateConversationMessage({
          spaceId,
          conversationId,
          content,
        })
      : await workspaceClient.genie.genieStartConversation({
          spaceId,
          content,
        });
    return {
      messageWaiter: this.messagePoller(
        workspaceClient,
        spaceId,
        started.conversationId,
        started.messageId,
      ),
      conversationId: started.conversationId,
      messageId: started.messageId,
    };
  }

  /**
   * Polls `getConversationMessage` until COMPLETED. Replaces the SDK waiter: the
   * modular `wait()` has no `onProgress`, which the SSE `status` events need. It
   * mirrors the legacy waiter: progress on every poll, backoff of `attempt`
   * seconds + 50-750ms jitter capped at 10s, a 10 minute default timeout, and the
   * same `failed to reach COMPLETED state` errors `classifyGenieError` matches.
   */
  private messagePoller(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    messageId: string,
  ): CreateMessageWaiter {
    return {
      async wait(options) {
        const timeout =
          typeof options?.timeout === "number"
            ? options.timeout
            : DEFAULT_WAIT_TIMEOUT_MS;
        const deadline = Date.now() + timeout;
        let lastStatus: string | undefined;
        for (let attempt = 1; Date.now() < deadline; attempt++) {
          const message =
            await workspaceClient.genie.genieGetConversationMessage({
              spaceId,
              conversationId,
              messageId,
            });
          await options?.onProgress?.(message);
          lastStatus = message.status;
          if (lastStatus === "COMPLETED") return message;
          if (lastStatus === "FAILED") {
            throw new Error("failed to reach COMPLETED state, got FAILED");
          }
          const jitter = 50 + Math.random() * 700;
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(attempt * 1000 + jitter, MAX_POLL_INTERVAL_MS),
            ),
          );
        }
        throw new Error(
          `timed out: failed to reach COMPLETED state, got ${lastStatus}`,
        );
      },
    };
  }

  async waitForMessage(
    messageWaiter: CreateMessageWaiter,
    options?: { timeout?: number },
  ): Promise<GenieMessage> {
    const timeout = options?.timeout ?? this.config.timeout;
    return messageWaiter.wait(timeout > 0 ? { timeout } : {});
  }

  async listConversationMessages(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    options?: { pageSize?: number; pageToken?: string },
  ): Promise<{
    messages: GenieMessageResponse[];
    nextPageToken: string | null;
  }> {
    const pageSize =
      options?.pageSize ?? genieConnectorDefaults.initialPageSize;

    const response = await workspaceClient.genie.genieListConversationMessages({
      spaceId,
      conversationId,
      pageSize,
      ...(options?.pageToken ? { pageToken: options.pageToken } : {}),
    });

    const messages = (response.messages ?? []).reverse().map(toMessageResponse);

    return {
      messages,
      nextPageToken: response.nextPageToken ?? null,
    };
  }

  async getMessageAttachmentQueryResult(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    messageId: string,
    attachmentId: string,
    _signal?: AbortSignal,
  ): Promise<GenieStatementResponse> {
    const response =
      await workspaceClient.genie.genieGetMessageAttachmentQueryResult({
        spaceId,
        conversationId,
        messageId,
        attachmentId,
      });
    return toWireShape(response.statementResponse) as GenieStatementResponse;
  }

  async *streamSendMessage(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    content: string,
    conversationId: string | undefined,
    options?: { timeout?: number; signal?: AbortSignal },
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
      const waitOptions = timeout > 0 ? { timeout } : {};

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
      logger.error(
        "Genie message error (spaceId=%s, conversationId=%s): %O",
        spaceId,
        conversationId ?? "new",
        error,
      );
      yield { type: "error", error: classifyGenieError(error) };
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
          error: `${GenieErrors.QUERY_RESULT_FAILED} for attachment ${att.attachmentId}`,
        };
      }
    }
  }

  async *streamConversation(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    options?: {
      includeQueryResults?: boolean;
      pageSize?: number;
      pageToken?: string;
      signal?: AbortSignal;
    },
  ): AsyncGenerator<GenieStreamEvent> {
    const includeQueryResults = options?.includeQueryResults !== false;

    try {
      const { messages: messageResponses, nextPageToken } =
        await this.listConversationMessages(
          workspaceClient,
          spaceId,
          conversationId,
          { pageSize: options?.pageSize, pageToken: options?.pageToken },
        );

      for (const messageResponse of messageResponses) {
        yield { type: "message_result", message: messageResponse };
      }

      yield {
        type: "history_info",
        conversationId,
        spaceId,
        nextPageToken,
        loadedCount: messageResponses.length,
      };

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
                  : GenieErrors.QUERY_RESULT_FAILED,
            };
          }
        }
      }
    } catch (error) {
      logger.error(
        "Genie getConversation error (spaceId=%s, conversationId=%s): %O",
        spaceId,
        conversationId,
        error,
      );
      yield { type: "error", error: classifyGenieError(error) };
    }
  }

  /**
   * Polls a single message via `getMessage` until it reaches a terminal
   * state (`COMPLETED` or `FAILED`). Yields the same event types as
   * `streamSendMessage` so callers can reuse the same SSE processing logic.
   */
  async *streamGetMessage(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    messageId: string,
    options?: { timeout?: number; pollInterval?: number; signal?: AbortSignal },
  ): AsyncGenerator<GenieStreamEvent> {
    const pollInterval = options?.pollInterval ?? 3_000;
    const signal = options?.signal;
    let lastStatus = "";

    try {
      while (true) {
        if (signal?.aborted) return;

        const message = await workspaceClient.genie.genieGetConversationMessage(
          { spaceId, conversationId, messageId },
          { signal },
        );

        if (message.status && message.status !== lastStatus) {
          lastStatus = message.status;
          yield { type: "status", status: message.status };
        }

        const isTerminal =
          message.status === "COMPLETED" || message.status === "FAILED";
        if (isTerminal) {
          const messageResponse = toMessageResponse(message);
          yield { type: "message_result", message: messageResponse };
          yield* this.emitQueryResults(
            workspaceClient,
            spaceId,
            conversationId,
            messageId,
            messageResponse,
          );
          return;
        }

        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollInterval);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    } catch (error) {
      if (signal?.aborted) return;
      logger.error(
        "Genie getMessage poll error (spaceId=%s, conversationId=%s, messageId=%s): %O",
        spaceId,
        conversationId,
        messageId,
        error,
      );
      yield { type: "error", error: classifyGenieError(error) };
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
    const allMessages: GenieMessageResponse[] = [];
    let pageToken: string | undefined;

    do {
      const { messages, nextPageToken } = await this.listConversationMessages(
        workspaceClient,
        spaceId,
        conversationId,
        {
          pageSize: genieConnectorDefaults.pageSize,
          pageToken,
        },
      );
      allMessages.push(...messages);
      pageToken = nextPageToken ?? undefined;
    } while (pageToken && allMessages.length < this.config.maxMessages);

    return {
      conversationId,
      spaceId,
      messages: allMessages.slice(0, this.config.maxMessages),
    };
  }
}
