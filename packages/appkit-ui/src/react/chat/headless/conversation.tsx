import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import type { ReactNode } from "react";
import { type UseChatOptions, useChat } from "../hooks/use-chat";
import { useScrollToBottom } from "../hooks/use-scroll-to-bottom";
import type { ChatMessage } from "../types";

export interface ConversationRenderProps<
  TMessage extends UIMessage = ChatMessage,
> {
  messages: TMessage[];
  status: UseChatHelpers<TMessage>["status"];
  error: UseChatHelpers<TMessage>["error"];
  clearError: UseChatHelpers<TMessage>["clearError"];
  sendMessage: UseChatHelpers<TMessage>["sendMessage"];
  setMessages: UseChatHelpers<TMessage>["setMessages"];
  addToolApprovalResponse: UseChatHelpers<TMessage>["addToolApprovalResponse"];
  regenerate: UseChatHelpers<TMessage>["regenerate"];
  stop: () => void;
  id: string;
  title: string | undefined;
  isTitleLoading: boolean;
  isReadonly: boolean;
  isAtBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export interface ConversationProps<TMessage extends UIMessage = ChatMessage>
  extends UseChatOptions<TMessage> {
  children: (props: ConversationRenderProps<TMessage>) => ReactNode;
}

export function Conversation<TMessage extends UIMessage = ChatMessage>({
  children,
  ...chatOptions
}: ConversationProps<TMessage>) {
  const chat = useChat<TMessage>(chatOptions);
  const { containerRef, isAtBottom, scrollToBottom } = useScrollToBottom({
    trigger: chat.messages,
  });

  return children({
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    clearError: chat.clearError,
    sendMessage: chat.sendMessage,
    setMessages: chat.setMessages,
    addToolApprovalResponse: chat.addToolApprovalResponse,
    regenerate: chat.regenerate,
    stop: chat.stop,
    id: chat.id,
    title: chat.title,
    isTitleLoading: chat.isTitleLoading,
    isReadonly: chat.isReadonly,
    isAtBottom,
    scrollToBottom,
    containerRef,
  });
}
