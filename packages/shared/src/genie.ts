/** SSE event discriminated union produced by streamSendMessage and streamConversation */
export type GenieStreamEvent =
  | {
      type: "message_start";
      conversationId: string;
      messageId: string;
      spaceId: string;
    }
  | { type: "status"; status: string }
  /** Agent mode only: one step of the agent's reasoning, sent as it happens. */
  | { type: "reasoning"; content: string }
  | { type: "message_result"; message: GenieMessageResponse }
  | {
      type: "query_result";
      attachmentId: string;
      statementId: string;
      data: GenieStatementResponse;
    }
  | { type: "error"; error: string }
  | {
      type: "history_info";
      conversationId: string;
      spaceId: string;
      /** Opaque token to fetch the next (older) page. Null means no more pages. */
      nextPageToken: string | null;
      /** Total messages returned in this initial load */
      loadedCount: number;
    };

/**
 * Shape of the Databricks SQL statement response returned by Genie queries.
 * The server sends the modular SDK's camelCase shape; the snake_case fields are
 * the legacy raw-API shape, still accepted by appkit-ui for older servers.
 */
export interface GenieStatementResponse {
  manifest: {
    schema: {
      columns: Array<{
        name: string;
        typeName?: string;
        /** @deprecated Legacy snake_case shape; use `typeName`. */
        type_name?: string;
      }>;
    };
  };
  result: {
    dataArray?: (string | null)[][];
    /** @deprecated Legacy snake_case shape; use `dataArray`. */
    data_array?: (string | null)[][];
  };
}

/** Cleaned response — subset of SDK GenieMessage */
export interface GenieMessageResponse {
  messageId: string;
  conversationId: string;
  spaceId: string;
  status: string;
  content: string;
  attachments?: GenieAttachmentResponse[];
  error?: string;
  /** Agent mode only: the agent's reasoning steps, in order. */
  reasoning?: string[];
}

export interface GenieAttachmentResponse {
  attachmentId?: string;
  query?: {
    title?: string;
    description?: string;
    query?: string;
    statementId?: string;
  };
  text?: { content?: string };
  suggestedQuestions?: string[];
  /**
   * A chart Genie rendered for a query. Fetch it as a PNG from the plugin's
   * `visualization` route with this attachment's `attachmentId`.
   */
  viz?: {
    title?: string;
    /** The query attachment the chart was generated from. */
    queryAttachmentId?: string;
  };
}
