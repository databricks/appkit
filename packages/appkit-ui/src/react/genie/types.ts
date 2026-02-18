/**
 * Frontend-side Genie types, mirroring backend shapes to avoid
 * pulling Node.js dependencies into the browser bundle.
 */

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

export type GenieChatStatus =
  | "idle"
  | "loading-history"
  | "streaming"
  | "error";

export interface GenieMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  attachments: GenieAttachmentResponse[];
  queryResults: Map<string, unknown>;
  error?: string;
}

export interface UseGenieChatOptions {
  /** Genie space alias (maps to backend route param) */
  alias: string;
  /** Base API path. Default: "/api/genie" */
  basePath?: string;
  /** Read/write conversationId from URL search params. Default: true */
  persistInUrl?: boolean;
  /** URL search param name. Default: "conversationId" */
  urlParamName?: string;
}

export interface UseGenieChatReturn {
  messages: GenieMessageItem[];
  status: GenieChatStatus;
  conversationId: string | null;
  error: string | null;
  sendMessage: (content: string) => void;
  reset: () => void;
}

export interface GenieChatProps {
  /** Genie space alias */
  alias: string;
  /** Base API path. Default: "/api/genie" */
  basePath?: string;
  /** Placeholder text for the input. Default: "Ask a question..." */
  placeholder?: string;
  /** Custom className for the root container */
  className?: string;
}
