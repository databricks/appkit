import { createContext, useContext } from "react";
import type { ChatFeatures, ChatSession } from "./types";

export interface ChatContextValue {
  apiBase: string;
  basePath: string;
  features: ChatFeatures;
  chatHistoryEnabled: boolean;
  feedbackEnabled: boolean;
  session: ChatSession | null;
  isLoading: boolean;
  onNavigate?: (chatId: string) => void;
}

export const ChatContext = createContext<ChatContextValue | undefined>(
  undefined,
);

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return ctx;
}
