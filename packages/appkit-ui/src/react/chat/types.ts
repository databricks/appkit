import type { LanguageModelUsage, UIMessage } from "ai";

// Custom data types for the AI SDK stream

export type ChatCustomUIDataTypes = {
  error: string;
  usage: LanguageModelUsage;
  traceId: string | null;
  title: string;
};

type MessageMetadata = {
  createdAt: string;
};

// biome-ignore lint/complexity/noBannedTypes: empty default tool registry — consumers extend this type
export type ChatTools = {};

export type ChatMessage = UIMessage<MessageMetadata, ChatCustomUIDataTypes>;

// Domain types

export interface ChatAttachment {
  name: string;
  url: string;
  contentType: string;
}

export type ChatVisibilityType = "private" | "public";

export interface ChatFeedback {
  messageId: string;
  feedbackType: "thumbs_up" | "thumbs_down";
  assessmentId: string | null;
}

export type ChatFeedbackMap = Record<string, ChatFeedback>;

export interface ChatSession {
  user: {
    email: string;
    name?: string;
    preferredUsername?: string;
  } | null;
}

export interface Chat {
  id: string;
  createdAt: Date;
  title: string;
  userId: string;
  visibility: "public" | "private";
  lastContext: {
    inputTokens?: {
      total?: number;
      noCache?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    outputTokens?: {
      total?: number;
      text?: number;
      reasoning?: number;
    };
  } | null;
}

export interface DBMessage {
  id: string;
  chatId: string;
  role: string;
  parts: unknown;
  attachments: unknown;
  createdAt: Date;
  traceId: string | null;
}

export interface ChatFeatures {
  chatHistory: boolean;
  feedback: boolean;
}

export interface ChatHistoryPage {
  chats: Array<Chat>;
  hasMore: boolean;
}
