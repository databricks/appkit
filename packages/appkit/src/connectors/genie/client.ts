import { createLogger } from "../../logging";
import { readSseEvents } from "../../stream/sse-reader";
import type { GenieMessage, WorkspaceClient } from "../../workspace-client";
import {
  addAgentItem,
  agentToolStatus,
  type GenieAgentItem,
  type GenieAgentStreamEvent,
  type GenieAgentTurn,
  newAgentTurn,
  withAgentTurn,
} from "./agent";
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

// The agent items endpoint returns at most 100 items per page.
const AGENT_ITEMS_PAGE_SIZE = 100;
const MAX_AGENT_ITEM_PAGES = 20;

// IDs Genie hands out (hex ids, `pub_toolu_…_output` attachment ids).
const GENIE_ID_PATTERN = /^[\w-]+$/;

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
      viz:
        attachment?.$case === "viz"
          ? {
              title: attachment.viz.title,
              queryAttachmentId: attachment.viz.queryAttachmentId,
            }
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

/** Agent endpoints answer `{"error": {"type", "message"}}`, a shape ApiError doesn't parse. */
function classifyGenieAgentError(error: unknown): string {
  const nested = (error as { response?: { error?: { message?: unknown } } })
    ?.response?.error?.message;
  return typeof nested === "string" ? nested : classifyGenieError(error);
}

/** Whether `id` is safe to put into a Genie resource path. */
export function isGenieId(id: string): boolean {
  return GENIE_ID_PATTERN.test(id);
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
    return response.statementResponse as GenieStatementResponse;
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

  /**
   * Agent mode: runs one agent turn (`POST /genie/agents/{id}/responses`, which
   * the SDK doesn't cover) and maps its stream onto the chat-mode events, plus
   * a `reasoning` event per reasoning step. Once the turn completes, the
   * message is read back for its query and chart attachments. A turn that is
   * aborted or times out before it completes is cancelled upstream.
   */
  async *streamAgentResponse(
    workspaceClient: WorkspaceClient,
    agentId: string,
    content: string,
    conversationId: string | undefined,
    options?: { timeout?: number; signal?: AbortSignal },
  ): AsyncGenerator<GenieStreamEvent> {
    const callerSignal = options?.signal;
    const timeout = options?.timeout ?? this.config.timeout;
    const timeoutSignal =
      timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
    const signal = AbortSignal.any(
      [callerSignal, timeoutSignal].filter((s) => s !== undefined),
    );
    let started: { conversationId: string; messageId: string } | undefined;
    let completed = false;
    try {
      const response = await workspaceClient.request({
        method: "POST",
        path: `/api/2.0/genie/agents/${encodeURIComponent(agentId)}/responses`,
        headers: new Headers({
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        }),
        body: JSON.stringify({
          enable_viz: true,
          conversation_id: conversationId,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: content }],
            },
          ],
        }),
        signal,
      });
      if (!response.body) throw new Error(GenieErrors.REQUEST_FAILED);

      const turn = newAgentTurn();
      for await (const { data } of readSseEvents(response.body, signal)) {
        const event = JSON.parse(data) as GenieAgentStreamEvent;
        if (event.type === "response.created" && event.response) {
          started = {
            conversationId: event.response.conversation_id,
            messageId: event.response.id,
          };
          yield { type: "message_start", ...started, spaceId: agentId };
        } else if (event.type === "response.output_item.done" && event.item) {
          const status = agentToolStatus(event.item);
          if (status) yield { type: "status", status };
          const reasoning = addAgentItem(turn, event.item);
          if (reasoning) yield { type: "reasoning", content: reasoning };
        } else if (event.type === "response.completed") {
          // A turn cancelled elsewhere (another client, Genie itself) also ends here.
          const status = event.response?.status;
          if (status && status !== "completed") {
            throw new Error(`Genie agent response ${status}`);
          }
          completed = true;
        } else if (event.type === "response.failed" || event.type === "error") {
          throw new Error(
            event.response?.error?.message ??
              event.message ??
              GenieErrors.REQUEST_FAILED,
          );
        }
      }
      signal.throwIfAborted();
      if (!started || !completed) {
        throw new Error("Genie agent response ended before it completed");
      }

      const message = await workspaceClient.genie.genieGetConversationMessage(
        { spaceId: agentId, ...started },
        { signal },
      );
      const messageResponse = withAgentTurn(toMessageResponse(message), turn);
      yield { type: "message_result", message: messageResponse };
      yield* this.emitQueryResults(
        workspaceClient,
        agentId,
        started.conversationId,
        started.messageId,
        messageResponse,
      );
    } catch (error) {
      if (signal.aborted && started && !completed) {
        this.cancelAgentResponse(workspaceClient, agentId, started);
      }
      if (callerSignal?.aborted) return;
      if (timeoutSignal?.aborted) {
        yield {
          type: "error",
          error: `Genie agent response timed out after ${timeout} ms`,
        };
        return;
      }
      logger.error(
        "Genie agent response error (agentId=%s, conversationId=%s): %O",
        agentId,
        conversationId ?? "new",
        error,
      );
      yield { type: "error", error: classifyGenieAgentError(error) };
    }
  }

  /** Best effort: stops an abandoned agent turn so it doesn't keep running upstream. */
  private cancelAgentResponse(
    workspaceClient: WorkspaceClient,
    agentId: string,
    {
      conversationId,
      messageId,
    }: { conversationId: string; messageId: string },
  ): void {
    workspaceClient.genie
      .genieCancelResponse({ agentId, conversationId, responseId: messageId })
      .catch((error) =>
        logger.warn(
          "Failed to cancel Genie agent response %s: %O",
          messageId,
          error,
        ),
      );
  }

  /**
   * Agent mode: adds the answer text and reasoning to messages read from the
   * message projection, which has neither. They come from the conversation's
   * items (`GET /genie/agents/{id}/conversations/{cid}/items`).
   */
  private async withAgentTurns(
    workspaceClient: WorkspaceClient,
    agentId: string,
    conversationId: string,
    messages: GenieMessageResponse[],
    signal?: AbortSignal,
  ): Promise<GenieMessageResponse[]> {
    const turns = new Map<string, GenieAgentTurn>();
    let after: string | undefined;
    try {
      // shortcut: reads every item of the conversation for each history page; align item pages with message pages if long agent conversations matter.
      for (let page = 0; page < MAX_AGENT_ITEM_PAGES; page++) {
        const response = await workspaceClient.request({
          method: "GET",
          path: `/api/2.0/genie/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/items`,
          query: {
            limit: String(AGENT_ITEMS_PAGE_SIZE),
            ...(after ? { after } : {}),
          },
          signal,
        });
        const body = (await response.json()) as {
          data?: GenieAgentItem[];
          has_more?: boolean;
          last_id?: string;
        };
        for (const item of body.data ?? []) {
          const messageId = item.metadata?.message_id;
          if (!messageId) continue;
          let turn = turns.get(messageId);
          if (!turn) {
            turn = newAgentTurn();
            turns.set(messageId, turn);
          }
          addAgentItem(turn, item);
        }
        if (!body.has_more || !body.last_id) break;
        after = body.last_id;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // E.g. a chat conversation opened through an agent alias: its messages already carry their text.
      logger.warn(
        "Genie agent items unavailable (agentId=%s, conversationId=%s), returning messages without them: %O",
        agentId,
        conversationId,
        error,
      );
      return messages;
    }
    return messages.map((message) =>
      withAgentTurn(message, turns.get(message.messageId)),
    );
  }

  /**
   * Downloads the PNG Genie rendered for a visualization attachment. The
   * message must be COMPLETED.
   */
  async downloadVisualization(
    workspaceClient: WorkspaceClient,
    spaceId: string,
    conversationId: string,
    messageId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream | undefined> {
    // The SDK puts `name` into the URL unencoded, so only plain ids may reach it.
    if (![spaceId, conversationId, messageId, attachmentId].every(isGenieId)) {
      throw new Error("Invalid Genie id");
    }
    const { contents } =
      await workspaceClient.genie.downloadMessageAttachmentVisualization(
        {
          name: `spaces/${spaceId}/conversations/${conversationId}/messages/${messageId}/attachments/${attachmentId}`,
        },
        { signal },
      );
    return contents;
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
      /** The space is used in agent mode. */
      agent?: boolean;
    },
  ): AsyncGenerator<GenieStreamEvent> {
    const includeQueryResults = options?.includeQueryResults !== false;

    try {
      const page = await this.listConversationMessages(
        workspaceClient,
        spaceId,
        conversationId,
        {
          pageSize: options?.pageSize,
          pageToken: options?.pageToken,
        },
      );
      const { nextPageToken } = page;
      const messageResponses = options?.agent
        ? await this.withAgentTurns(
            workspaceClient,
            spaceId,
            conversationId,
            page.messages,
            options.signal,
          )
        : page.messages;

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
    options?: {
      timeout?: number;
      pollInterval?: number;
      signal?: AbortSignal;
      /** The space is used in agent mode. */
      agent?: boolean;
    },
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
          let messageResponse = toMessageResponse(message);
          if (options?.agent) {
            [messageResponse] = await this.withAgentTurns(
              workspaceClient,
              spaceId,
              conversationId,
              [messageResponse],
              signal,
            );
          }
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
    options?: { agent?: boolean },
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

    const kept = allMessages.slice(0, this.config.maxMessages);
    return {
      conversationId,
      spaceId,
      messages: options?.agent
        ? await this.withAgentTurns(
            workspaceClient,
            spaceId,
            conversationId,
            kept,
          )
        : kept,
    };
  }
}
