import type { BasePluginConfig } from "shared";

export interface IGenieConfig extends BasePluginConfig {
  /** Map of alias → Genie Space ID. Defaults to { default: DATABRICKS_GENIE_SPACE_ID } if omitted. */
  spaces?: Record<string, string>;
  /** Genie polling timeout in ms. Set to 0 for indefinite. Default: 120000 (2 min) */
  timeout?: number;
}

export interface GenieSendMessageRequest {
  content: string;
  conversationId?: string;
}

/** SSE event discriminated union */
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
  | { type: "error"; error: string };

/** Cleaned response — subset of SDK's GenieMessage */
export interface GenieMessageResponse {
  messageId: string;
  conversationId: string;
  spaceId: string;
  status: string;
  content: string;
  attachments?: GenieAttachmentResponse[];
  error?: string;
}

export interface GenieConversationHistoryResponse {
  conversationId: string;
  spaceId: string;
  messages: GenieMessageResponse[];
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
