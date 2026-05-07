import type { UIMessagePart } from "ai";
import type {
  ChatCustomUIDataTypes,
  ChatMessage,
  ChatTools,
  DBMessage,
} from "../types";

/**
 * Convert messages from the DB shape (unknown JSON parts/attachments)
 * into the typed `ChatMessage` UI shape.
 */
export function convertToChatMessages(messages: DBMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role as "user" | "assistant" | "system",
    parts: message.parts as UIMessagePart<ChatCustomUIDataTypes, ChatTools>[],
    metadata: {
      createdAt:
        typeof message.createdAt === "string"
          ? message.createdAt
          : message.createdAt.toISOString(),
    },
  }));
}
