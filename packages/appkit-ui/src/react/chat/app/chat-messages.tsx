import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatStatus, UIMessage } from "ai";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { ArrowDownIcon, DbIcon } from "../db-icons";
import { ChatAwaitingResponse } from "./chat-awaiting-response";
import {
  type ApprovalEntry,
  ChatMessage,
  type ChatMessageProps,
} from "./chat-message";
import type { ChatToolCallProps } from "./chat-tool-call";

interface ChatMessagesProps<TMessage extends UIMessage = UIMessage> {
  messages: TMessage[];
  status: ChatStatus;
  /**
   * Scroll-container ref. `useScrollToBottom` returns a ref callback
   * (not a RefObject) so the listener attaches when the node mounts —
   * forward whatever the hook gives you.
   */
  containerRef: (node: HTMLDivElement | null) => void;
  isAtBottom: boolean;
  scrollToBottom: () => void;
  approvals: Map<string, ApprovalEntry>;
  onApprove: (approvalId: string, streamId: string) => void;
  onDeny: (approvalId: string, streamId: string) => void;
  /** Forwarded to each `<ChatMessage>` to enable user-message editing. */
  setMessages?: UseChatHelpers<TMessage>["setMessages"];
  regenerate?: UseChatHelpers<TMessage>["regenerate"];
  /** Override per-message rendering. Return undefined to fall through. */
  renderMessage?: (props: ChatMessageProps<TMessage>) => ReactNode | undefined;
  /** Forwarded to each `<ChatMessage>`. */
  renderToolCall?: (props: ChatToolCallProps) => ReactNode | undefined;
  className?: string;
}

/**
 * Auto-sticking conversation list with a floating scroll-to-bottom
 * button when the user has scrolled up.
 */
export function ChatMessages<TMessage extends UIMessage = UIMessage>({
  messages,
  status,
  containerRef,
  isAtBottom,
  scrollToBottom,
  approvals,
  onApprove,
  onDeny,
  setMessages,
  regenerate,
  renderMessage,
  renderToolCall,
  className,
}: ChatMessagesProps<TMessage>) {
  // Shimmer between the user's message and the not-yet-created
  // assistant stub. Once the stub exists, ChatMessage handles it inline.
  const lastMessage = messages[messages.length - 1];
  const needsBetweenAwaiting =
    (status === "submitted" || status === "streaming") &&
    lastMessage?.role === "user";

  return (
    <div className={cn("relative min-h-0 flex-1 overflow-hidden", className)}>
      <div
        ref={containerRef}
        className="h-full overflow-y-auto"
        style={{ overflowAnchor: "none" }}
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6 md:gap-6 md:px-6">
          {messages.map((message, index) => {
            const isLastAssistant =
              index === messages.length - 1 && message.role === "assistant";
            const isLoading = status === "streaming" && isLastAssistant;
            const props: ChatMessageProps<TMessage> = {
              message,
              isLoading,
              approvals,
              onApprove,
              onDeny,
              setMessages,
              regenerate,
              renderToolCall,
            };
            const custom = renderMessage?.(props);
            if (custom !== undefined) {
              return <div key={message.id}>{custom}</div>;
            }
            return <ChatMessage key={message.id} {...props} />;
          })}

          {needsBetweenAwaiting && <ChatAwaitingResponse />}
        </div>
      </div>

      {!isAtBottom && messages.length > 0 && (
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={() => scrollToBottom()}
          aria-label="Scroll to bottom"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-lg"
        >
          <DbIcon icon={ArrowDownIcon} />
        </Button>
      )}
    </div>
  );
}
