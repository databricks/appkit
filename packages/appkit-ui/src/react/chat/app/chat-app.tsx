import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatStatus, UIMessage, UIMessageChunk } from "ai";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { type UseChatOptions, useChat } from "../hooks/use-chat";
import { useScrollToBottom } from "../hooks/use-scroll-to-bottom";
import { ChatComposer, type ChatComposerProps } from "./chat-composer";
import { ChatGreeting } from "./chat-greeting";
import type { ApprovalEntry, ChatMessageProps } from "./chat-message";
import { ChatMessages } from "./chat-messages";
import type { ChatToolCallProps } from "./chat-tool-call";

export interface ApprovalDecision {
  approvalId: string;
  streamId: string;
  decision: "approve" | "deny";
}

const DEFAULT_API = "/api/agents/chat";

export interface ChatAppProps<TMessage extends UIMessage = UIMessage>
  extends Omit<UseChatOptions<TMessage>, "api"> {
  /** Chat endpoint URL. Defaults to `/api/agents/chat`. */
  api?: string;
  /** Empty-state node shown when there are no messages yet. */
  emptyState?: ReactNode;
  /** Placeholder text for the default composer. */
  placeholder?: string;
  /** Caption shown below the composer. Pass `null` to suppress. */
  composerCaption?: string | null;
  /** Override per-message rendering. Return undefined to fall through. */
  renderMessage?: (props: ChatMessageProps<TMessage>) => ReactNode | undefined;
  /** Override tool-call rendering. Return undefined to fall through. */
  renderToolCall?: (props: ChatToolCallProps) => ReactNode | undefined;
  /** Override the composer entirely. */
  renderComposer?: (
    props: ChatComposerProps<TMessage>,
  ) => ReactNode | undefined;
  /**
   * Called when the user clicks Allow / Deny. Throw to keep the card
   * `pending`. Defaults to a POST against {@link approveUrl}.
   */
  onApprovalDecision?: (decision: ApprovalDecision) => Promise<void> | void;
  /** Defaults to `api` with `/chat` swapped for `/approve`. */
  approveUrl?: string;
  className?: string;
}

function deriveApproveUrl(api: string, override: string | undefined): string {
  if (override) return override;
  if (api.endsWith("/chat")) return `${api.slice(0, -"/chat".length)}/approve`;
  return `${api}/approve`;
}

/**
 * Drop-in chat against an `agents()`-backed AppKit server. Fills its
 * parent — provide a sized container. For history, feedback, or file
 * attachments, wrap `useChat` directly instead.
 */
export function ChatApp<TMessage extends UIMessage = UIMessage>({
  api = DEFAULT_API,
  emptyState,
  placeholder,
  composerCaption,
  renderMessage,
  renderToolCall,
  renderComposer,
  onApprovalDecision,
  approveUrl,
  className,
  ...chatOptions
}: ChatAppProps<TMessage>) {
  const [approvals, setApprovals] = useState<Map<string, ApprovalEntry>>(
    () => new Map(),
  );

  // Ref'd so an inline `onData` doesn't re-bind the transport every render.
  const consumerOnDataRef = useRef(chatOptions.onData);
  consumerOnDataRef.current = chatOptions.onData;

  const handleData = useCallback<
    NonNullable<UseChatOptions<TMessage>["onData"]>
  >((part) => {
    if (part.type === "data-approval-pending") {
      const data = (part as { data: Record<string, unknown> }).data;
      const approvalId = String(data.approvalId ?? "");
      if (approvalId) {
        setApprovals((prev) => {
          // Don't clobber an in-flight or completed decision if the
          // server re-emits the pending event.
          if (prev.has(approvalId)) return prev;
          const next = new Map(prev);
          next.set(approvalId, {
            approvalId,
            streamId: String(data.streamId ?? ""),
            toolName: String(data.toolName ?? "tool"),
            args: data.args,
            annotations: data.annotations as ApprovalEntry["annotations"],
            state: "pending",
          });
          return next;
        });
      }
    }
    consumerOnDataRef.current?.(part);
  }, []);

  const chat = useChat<TMessage>({
    ...chatOptions,
    api,
    onData: handleData,
  });

  const { containerRef, isAtBottom, scrollToBottom } =
    useScrollToBottom<HTMLDivElement>({ trigger: chat.messages });

  const submitDecision = useCallback(
    async (decision: ApprovalDecision) => {
      const setState = (state: ApprovalEntry["state"]) => {
        setApprovals((prev) => {
          const next = new Map(prev);
          const existing = next.get(decision.approvalId);
          next.set(decision.approvalId, {
            approvalId: decision.approvalId,
            streamId: decision.streamId,
            toolName: existing?.toolName ?? "",
            args: existing?.args,
            annotations: existing?.annotations,
            state,
          });
          return next;
        });
      };
      setState("submitting");
      try {
        if (onApprovalDecision) {
          await onApprovalDecision(decision);
        } else {
          const url = deriveApproveUrl(api, approveUrl);
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              streamId: decision.streamId,
              approvalId: decision.approvalId,
              decision: decision.decision,
            }),
          });
          if (!res.ok) {
            throw new Error(
              `Approval POST failed: ${res.status} ${res.statusText}`,
            );
          }
        }
        setState(decision.decision === "approve" ? "approved" : "denied");
      } catch (err) {
        // Roll back to pending so the user can retry.
        console.error("[ChatApp] approval decision failed", err);
        setState("pending");
      }
    },
    [onApprovalDecision, approveUrl, api],
  );

  const onApprove = useCallback(
    (approvalId: string, streamId: string) => {
      void submitDecision({ approvalId, streamId, decision: "approve" });
    },
    [submitDecision],
  );
  const onDeny = useCallback(
    (approvalId: string, streamId: string) => {
      void submitDecision({ approvalId, streamId, decision: "deny" });
    },
    [submitDecision],
  );

  const composerProps: ChatComposerProps<TMessage> = {
    sendMessage: chat.sendMessage,
    status: chat.status,
    stop: chat.stop,
    placeholder,
    caption: composerCaption,
  };
  const composer = renderComposer?.(composerProps) ?? (
    <ChatComposer<TMessage> {...composerProps} />
  );

  const isEmpty = chat.messages.length === 0;

  return (
    <div
      data-appkit-chat=""
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
    >
      {isEmpty ? (
        <div className="flex flex-1 items-center justify-center px-4 py-6">
          <div className="flex w-full max-w-3xl flex-col items-stretch">
            {emptyState ?? <ChatGreeting />}
            {composer}
          </div>
        </div>
      ) : (
        <>
          <ChatMessages<TMessage>
            messages={chat.messages}
            status={chat.status}
            containerRef={containerRef}
            isAtBottom={isAtBottom}
            scrollToBottom={scrollToBottom}
            approvals={approvals}
            onApprove={onApprove}
            onDeny={onDeny}
            setMessages={chat.setMessages}
            regenerate={chat.regenerate}
            renderMessage={renderMessage}
            renderToolCall={renderToolCall}
          />
          {chat.error && (
            <div className="mx-auto w-full max-w-4xl px-4 pb-2">
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {chat.error.message}
              </div>
            </div>
          )}
          <div className="sticky bottom-0 z-10 mx-auto w-full max-w-3xl px-2 pb-3 md:px-4 md:pb-4">
            {composer}
          </div>
        </>
      )}
    </div>
  );
}

// Re-exports for slot consumers.
export type {
  ApprovalEntry,
  ChatComposerProps,
  ChatMessageProps,
  ChatStatus,
  ChatToolCallProps,
  UIMessageChunk,
  UseChatHelpers,
};
