/** SSE event discriminated union produced by streamSendMessage and streamConversation */

import type { GenieMessageResponse } from "shared";

export type {
  GenieAttachmentResponse,
  GenieMessageResponse,
  GenieStreamEvent,
} from "shared";

export interface GenieConversationHistoryResponse {
  conversationId: string;
  spaceId: string;
  messages: GenieMessageResponse[];
}
