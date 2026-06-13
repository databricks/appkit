import type { UIMessage } from "ai";
import type { ReactNode } from "react";
import {
  type UseChatOptions,
  type UseChatReturn,
  useChat,
} from "../hooks/use-chat";
import {
  type UseScrollToBottomReturn,
  useScrollToBottom,
} from "../hooks/use-scroll-to-bottom";

export type ConversationRenderProps<TMessage extends UIMessage = UIMessage> =
  UseChatReturn<TMessage> &
    Pick<
      UseScrollToBottomReturn<HTMLDivElement>,
      "containerRef" | "isAtBottom" | "scrollToBottom"
    >;

export interface ConversationProps<TMessage extends UIMessage = UIMessage>
  extends UseChatOptions<TMessage> {
  /** Render prop receiving merged `useChat` + `useScrollToBottom` state. */
  children: (props: ConversationRenderProps<TMessage>) => ReactNode;
}

/**
 * Render-prop convenience over `useChat` + `useScrollToBottom`. Streams
 * Responses-API SSE from an AppKit `agents()`-backed endpoint, captures
 * the server-allocated `threadId` for multi-turn continuity, and
 * auto-sticks the scroll container to the bottom while the user is at
 * the bottom. Drop down to the underlying hooks for non-standard
 * layouts (split panes, virtualized lists, external send buttons).
 */
export function Conversation<TMessage extends UIMessage = UIMessage>({
  children,
  ...chatOptions
}: ConversationProps<TMessage>) {
  const chat = useChat<TMessage>(chatOptions);
  const scroll = useScrollToBottom({ trigger: chat.messages });
  return children({ ...chat, ...scroll });
}
