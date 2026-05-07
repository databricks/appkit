import type { ReactNode } from "react";
import { useChatHistory } from "../hooks/use-history";
import type { Chat } from "../types";

export interface ChatHistoryListRenderProps {
  chats: Chat[];
  isLoading: boolean;
  isValidating: boolean;
  hasMore: boolean;
  isEmpty: boolean;
  loadMore: () => void;
  deleteChat: (id: string) => Promise<void>;
  renameChat: (id: string, title: string) => Promise<void>;
}

export interface ChatHistoryListProps {
  children: (props: ChatHistoryListRenderProps) => ReactNode;
}

export function ChatHistoryList({
  children,
}: ChatHistoryListProps) {
  const history = useChatHistory();
  return children(history);
}
