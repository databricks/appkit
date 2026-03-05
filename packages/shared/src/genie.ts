/** SSE event discriminated union produced by streamSendMessage and streamConversation */
export type GenieStreamEvent =
  | {
      type: "message_start";
      conversationId: string;
      messageId: string;
      spaceId: string;
    }
  | { type: "status"; status: string }
  | { type: "message_result"; message: GenieMessageResponse }
  | {
      type: "query_result";
      attachmentId: string;
      statementId: string;
      data: unknown;
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

/** Cleaned response — subset of SDK GenieMessage */
export interface GenieMessageResponse {
  messageId: string;
  conversationId: string;
  spaceId: string;
  status: string;
  content: string;
  attachments?: GenieAttachmentResponse[];
  error?: string;
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
}
