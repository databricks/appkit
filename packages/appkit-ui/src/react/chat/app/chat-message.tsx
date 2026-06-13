import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";
import { ChatAwaitingResponse } from "./chat-awaiting-response";
import { ChatMarkdown } from "./chat-markdown";
import { ChatMessageActions } from "./chat-message-actions";
import { ChatMessageEditor } from "./chat-message-editor";
import { ChatReasoning } from "./chat-reasoning";
import {
  ChatToolCall,
  type ChatToolCallProps,
  type ChatToolCallState,
} from "./chat-tool-call";

/** Approval-gate lifecycle, owned by `ChatApp`. */
export interface ApprovalEntry {
  approvalId: string;
  streamId: string;
  toolName: string;
  args: unknown;
  state: "pending" | "submitting" | "approved" | "denied";
  annotations?: {
    effect?: "read" | "write" | "update" | "destructive";
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
  };
}

export interface ChatMessageProps<TMessage extends UIMessage = UIMessage> {
  message: TMessage;
  /** True while this message is the last assistant message and the chat is streaming. */
  isLoading: boolean;
  /** Approval state map keyed by `approvalId`. */
  approvals: Map<string, ApprovalEntry>;
  onApprove: (approvalId: string, streamId: string) => void;
  onDeny: (approvalId: string, streamId: string) => void;
  /** Required to enable inline editing of user messages. */
  setMessages?: UseChatHelpers<TMessage>["setMessages"];
  regenerate?: UseChatHelpers<TMessage>["regenerate"];
  /** Return a ReactNode to override, `undefined` to fall through. */
  renderToolCall?: (props: ChatToolCallProps) => ReactNode | undefined;
}

interface ToolPart {
  type: string;
  toolCallId: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function isToolPart(part: { type: string }): part is ToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function approvalStateBadge(s: ApprovalEntry["state"]): ChatToolCallState {
  switch (s) {
    case "pending":
      return "approval-pending";
    case "submitting":
      return "approving";
    case "approved":
      return "approved";
    case "denied":
      return "denied";
  }
}

function toolStateBadge(s: string | undefined): ChatToolCallState {
  switch (s) {
    case "output-available":
      return "completed";
    case "output-error":
      return "error";
    default:
      return "pending";
  }
}

/**
 * Renders a single chat message. Unknown part types are ignored so
 * older builds don't break on future protocol additions.
 */
export function ChatMessage<TMessage extends UIMessage = UIMessage>({
  message,
  isLoading,
  approvals,
  onApprove,
  onDeny,
  setMessages,
  regenerate,
  renderToolCall,
}: ChatMessageProps<TMessage>) {
  const isUser = message.role === "user";
  const [mode, setMode] = useState<"view" | "edit">("view");
  const canEdit = isUser && Boolean(setMessages && regenerate);
  const parts = message.parts as Array<
    { type: string } & Record<string, unknown>
  >;

  // Show a shimmer inline once `start` has landed but no chunks yet.
  const visibleParts = parts.filter((p) => {
    if (p.type === "text") return Boolean((p as { text?: unknown }).text);
    if (p.type === "reasoning") {
      return String((p as { text?: unknown }).text ?? "").trim().length > 0;
    }
    return true;
  });
  const showInlineAwaiting = !isUser && isLoading && visibleParts.length === 0;

  return (
    <div
      data-role={message.role}
      data-testid={`message-${message.role}`}
      className={cn(
        "group/message flex w-full",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-col gap-3",
          isUser && mode === "view" ? "max-w-[80%]" : "w-full",
        )}
      >
        {showInlineAwaiting && <ChatAwaitingResponse />}

        {canEdit && mode === "edit" && setMessages && regenerate && (
          <ChatMessageEditor<TMessage>
            message={message}
            onCancel={() => setMode("view")}
            setMessages={setMessages}
            regenerate={regenerate}
          />
        )}

        {(!canEdit || mode === "view") &&
          parts.map((part, index) => {
            const key = `${message.id}-${index}`;

            if (part.type === "text") {
              const text = String((part as { text?: unknown }).text ?? "");
              if (!text) return null;
              if (isUser) {
                return (
                  <div
                    key={key}
                    className="bg-secondary text-secondary-foreground w-fit self-end wrap-break-word rounded-2xl px-3.5 py-2 text-left text-base whitespace-pre-wrap"
                  >
                    {text}
                  </div>
                );
              }
              return (
                <div key={key} className="text-base leading-relaxed">
                  <ChatMarkdown>{text}</ChatMarkdown>
                </div>
              );
            }

            if (part.type === "reasoning") {
              const text = String((part as { text?: unknown }).text ?? "");
              if (!text.trim()) return null;
              // Reasoning is only live while it's the trailing part.
              const isLastPart = index === parts.length - 1;
              return (
                <ChatReasoning
                  key={key}
                  text={text}
                  isStreaming={isLoading && isLastPart}
                />
              );
            }

            if (isToolPart(part)) {
              const toolPart = part as unknown as ToolPart;
              const toolName =
                toolPart.toolName ?? part.type.replace(/^tool-/, "");
              const props: ChatToolCallProps = {
                toolName,
                input: toolPart.input,
                output: toolPart.output,
                errorText: toolPart.errorText,
                state: toolStateBadge(toolPart.state),
              };
              const custom = renderToolCall?.(props);
              if (custom !== undefined) {
                return <div key={key}>{custom}</div>;
              }
              return <ChatToolCall key={key} {...props} />;
            }

            if (part.type === "data-approval-pending") {
              const data =
                (part as { data?: Record<string, unknown> }).data ?? {};
              const approvalId = String(data.approvalId ?? "");
              const entry = approvals.get(approvalId);
              const toolName = String(
                data.toolName ?? entry?.toolName ?? "tool",
              );
              const args = data.args ?? entry?.args;
              const streamId = String(data.streamId ?? entry?.streamId ?? "");
              const state: ApprovalEntry["state"] = entry?.state ?? "pending";
              const props: ChatToolCallProps = {
                toolName,
                input: args,
                state: approvalStateBadge(state),
                isApproval: true,
                onApprove: () => onApprove(approvalId, streamId),
                onDeny: () => onDeny(approvalId, streamId),
              };
              const custom = renderToolCall?.(props);
              if (custom !== undefined) {
                return <div key={key}>{custom}</div>;
              }
              return <ChatToolCall key={key} {...props} />;
            }

            if (part.type === "source-url") {
              const url = String((part as { url?: unknown }).url ?? "");
              const title = String((part as { title?: unknown }).title ?? url);
              if (!url) return null;
              return (
                <a
                  key={key}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-baseline text-primary hover:underline"
                >
                  <sup className="text-xs">[{title}]</sup>
                </a>
              );
            }

            return null;
          })}

        {mode === "view" && !isLoading && visibleParts.length > 0 && (
          <ChatMessageActions<TMessage>
            message={message}
            onEdit={canEdit ? () => setMode("edit") : undefined}
          />
        )}
      </div>
    </div>
  );
}
