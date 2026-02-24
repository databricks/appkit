/**
 * Frontend-side Multi-Genie types — mirrors backend shapes to avoid
 * pulling Node.js dependencies into the browser bundle.
 */

export interface MultiGenieAttachmentResponse {
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

export type MultiGenieStreamEvent =
  | { type: "agent_start"; userMessage: string }
  | { type: "agent_thinking"; iteration: number }
  | { type: "routing"; genieSpaces: string[] }
  | {
      type: "genie_space_result";
      alias: string;
      spaceId: string;
      conversationId: string;
      messageId: string;
      content: string;
      attachments: MultiGenieAttachmentResponse[];
      status: string;
    }
  | {
      type: "genie_query_result";
      alias: string;
      attachmentId: string;
      statementId: string;
      data: unknown;
    }
  | { type: "genie_space_error"; alias: string; error: string }
  | { type: "answer"; content: string }
  | { type: "error"; error: string };

export type MultiGenieChatStatus =
  | "idle"
  | "thinking"
  | "routing"
  | "querying"
  | "error";

export interface GenieSpaceResultItem {
  alias: string;
  spaceId: string;
  conversationId: string;
  messageId: string;
  content: string;
  attachments: MultiGenieAttachmentResponse[];
  queryResults: Map<string, unknown>;
  status: string;
  error?: string;
}

export interface MultiGenieMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  genieSpaceResults: GenieSpaceResultItem[];
  error?: string;
}

export interface UseMultiGenieChatOptions {
  basePath?: string;
}

export interface UseMultiGenieChatReturn {
  messages: MultiGenieMessageItem[];
  status: MultiGenieChatStatus;
  error: string | null;
  sendMessage: (content: string) => void;
  reset: () => void;
}

export interface MultiGenieChatProps {
  basePath?: string;
  placeholder?: string;
  className?: string;
}
