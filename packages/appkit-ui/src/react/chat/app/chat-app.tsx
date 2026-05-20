import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatStatus, UIMessage, UIMessageChunk } from "ai";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { PortalContainerProvider } from "../../portal-container-context";
import {
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "../../ui/sidebar";
import {
  DbIcon,
  NewChatIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
} from "../db-icons";
import { type UseChatOptions, useChat } from "../hooks/use-chat";
import { useDeleteThread } from "../hooks/use-delete-thread";
import { useScrollToBottom } from "../hooks/use-scroll-to-bottom";
import {
  type ApprovalDecision,
  useSubmitApproval,
} from "../hooks/use-submit-approval";
import { useThread } from "../hooks/use-thread";
import { useThreadList } from "../hooks/use-thread-list";
import { useThreadMessages } from "../hooks/use-thread-messages";
import { ChatComposer, type ChatComposerProps } from "./chat-composer";
import { ChatGreeting } from "./chat-greeting";
import { ChatHistorySidebar } from "./chat-history-sidebar";
import type { ApprovalEntry, ChatMessageProps } from "./chat-message";
import { ChatMessages } from "./chat-messages";
import type { ChatToolCallProps } from "./chat-tool-call";

const DEFAULT_API = "/api/agents/chat";

export interface ChatAppProps<TMessage extends UIMessage = UIMessage>
  extends Omit<UseChatOptions<TMessage>, "api"> {
  /** Chat endpoint URL. Defaults to `/api/agents/chat`. */
  api?: string;
  /**
   * When `true` (default), renders a left-hand history sidebar wired to
   * the `/threads` endpoints sibling to `api`. Pass `false` for the
   * single-conversation layout (no sidebar, no thread switching).
   */
  history?: boolean;
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

function deriveSiblingUrl(api: string, suffix: string): string {
  if (api.endsWith("/chat")) return `${api.slice(0, -"/chat".length)}${suffix}`;
  return `${api}${suffix}`;
}

function deriveApproveUrl(api: string, override: string | undefined): string {
  if (override) return override;
  return deriveSiblingUrl(api, "/approve");
}

function deriveThreadsUrl(api: string): string {
  return deriveSiblingUrl(api, "/threads");
}

/**
 * Drop-in chat against an `agents()`-backed AppKit server. With
 * `history` (default), renders a Databricks-styled, collapsible
 * sidebar listing the user's threads — wires to `GET/DELETE
 * ${api-with-/chat-replaced-by-/threads}`. Pass `history={false}` to
 * disable.
 *
 * Fills its parent — provide a sized container (e.g. `h-full` inside a
 * flex column or an explicit pixel height). The history sidebar uses
 * inline layout (no `position: fixed`), so embedding inside a panel
 * below a host header works without overlap.
 */
export function ChatApp<TMessage extends UIMessage = UIMessage>(
  props: ChatAppProps<TMessage>,
) {
  const { history = true, ...rest } = props;
  if (history) {
    return <ChatAppWithHistory<TMessage> {...rest} />;
  }
  return <ChatBody<TMessage> {...rest} />;
}

/**
 * `<ChatApp history>` wrapper. Owns thread-history state (active id,
 * new-chat nonce, list/thread fetches, delete) and re-keys the inner
 * {@link ChatBody} on thread switches so `useChat` reinitializes with
 * seeded messages — mirroring the pattern in
 * `apps/dev-playground/.../agent.route.tsx`.
 */
function ChatAppWithHistory<TMessage extends UIMessage = UIMessage>({
  api = DEFAULT_API,
  ...bodyProps
}: Omit<ChatAppProps<TMessage>, "history">) {
  const threadsApi = useMemo(() => deriveThreadsUrl(api), [api]);

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // Bumped on "New chat" so clicking the button always remounts the body
  // even when no thread is currently selected.
  const [newChatNonce, setNewChatNonce] = useState(0);

  const threadList = useThreadList({ api: threadsApi });
  const activeThread = useThread({
    api: threadsApi,
    threadId: activeThreadId,
  });
  const { messages: activeThreadMessages } = useThreadMessages(activeThread);

  // Seed gate: only mount the body with seeded messages once the fetched
  // thread id actually matches the selected one. Without this, a stale
  // previous-thread payload could briefly mount the body with the wrong
  // history before re-keying.
  //
  // TODO(hydration): this drops `tool`-role messages and only emits a
  // single `text` part per surviving message. Past tool invocations and
  // approval cards therefore do NOT re-render when a thread is resumed —
  // a conversation that previously ran a destructive tool looks like
  // plain Q&A on reload. To fix end-to-end we need a shared
  // Message → UIMessage converter that fans `Message.toolCalls` +
  // tool-output messages back into the `tool-*` /
  // `data-approval-pending` parts the renderer understands. Same TODO
  // lives in `apps/dev-playground/.../agent.route.tsx`.
  const seedMessages = useMemo<TMessage[] | undefined>(() => {
    if (!activeThreadId) return undefined;
    if (!activeThread.thread || activeThread.thread.id !== activeThreadId) {
      return undefined;
    }
    return activeThreadMessages
      .filter(
        (m) =>
          m.role === "user" || m.role === "assistant" || m.role === "system",
      )
      .map(
        (m) =>
          ({
            id: m.id,
            role: m.role as "user" | "assistant" | "system",
            parts: [{ type: "text" as const, text: m.content }],
          }) as unknown as TMessage,
      );
  }, [activeThreadId, activeThread.thread, activeThreadMessages]);

  const conversationReady = !activeThreadId || seedMessages !== undefined;

  const handleNewChat = useCallback(() => {
    setActiveThreadId(null);
    setNewChatNonce((n) => n + 1);
  }, []);

  const {
    deleteThread,
    loading: deleteLoading,
    error: deleteError,
  } = useDeleteThread({ api: threadsApi });
  const handleDeleteThread = useCallback(
    async (id: string) => {
      // Re-throw on failure so `ChatHistorySidebar` keeps the
      // confirmation dialog open and surfaces `deleteState.error`. The
      // hook already records the error; we just need the throw to
      // propagate past the sidebar's `await onDelete(...)`.
      await deleteThread(id);
      if (id === activeThreadId) {
        setActiveThreadId(null);
        setNewChatNonce((n) => n + 1);
      }
      await threadList.refresh();
    },
    [deleteThread, activeThreadId, threadList],
  );
  const deleteState = useMemo(
    () => ({ loading: deleteLoading, error: deleteError }),
    [deleteLoading, deleteError],
  );

  // Chain the caller's onFinish with a list-refresh so the sidebar
  // picks up the new thread (or updated `updatedAt`) once a turn ends.
  const callerOnFinishRef = useRef(bodyProps.onFinish);
  callerOnFinishRef.current = bodyProps.onFinish;
  const onFinish = useCallback<
    NonNullable<UseChatOptions<TMessage>["onFinish"]>
  >(
    (args) => {
      callerOnFinishRef.current?.(args);
      void threadList.refresh();
    },
    [threadList],
  );

  // Portal target so radix DropdownMenu/Tooltip/AlertDialog content
  // renders inside the chat boundary and inherits the chat-scoped styles
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
    null,
  );

  return (
    <div
      ref={setPortalContainer}
      data-appkit-chat=""
      className="bg-background h-full min-h-0 overflow-hidden"
    >
      <PortalContainerProvider container={portalContainer}>
        <SidebarProvider className="h-full min-h-0">
          <InlineSidebar>
            <HistorySidebarHeader />
            <div className="px-2 pt-2">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    type="button"
                    tooltip={{ children: "New chat", className: "text-base" }}
                    onClick={handleNewChat}
                    className="cursor-pointer"
                  >
                    <DbIcon icon={NewChatIcon} size={16} />
                    <span className="group-data-[collapsible=icon]:hidden">
                      New chat
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </div>

            {/* History list is suppressed in icon-collapsed mode — matches
              the original `{effectiveOpen && <SidebarHistory />}` gate
              from app-templates/.../app-sidebar.tsx. */}
            <SidebarContent className="group-data-[collapsible=icon]:hidden">
              <ChatHistorySidebar
                threads={threadList.threads}
                loading={threadList.loading}
                error={threadList.error}
                activeThreadId={activeThreadId}
                onSelect={setActiveThreadId}
                onDelete={handleDeleteThread}
                deleteState={deleteState}
              />
            </SidebarContent>
          </InlineSidebar>

          <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {conversationReady ? (
              <ChatBody<TMessage>
                key={activeThreadId ?? `new-${newChatNonce}`}
                api={api}
                {...bodyProps}
                threadId={activeThreadId ?? undefined}
                messages={seedMessages}
                onFinish={onFinish}
              />
            ) : (
              <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                Loading thread…
              </div>
            )}
          </main>
        </SidebarProvider>
      </PortalContainerProvider>
    </div>
  );
}

/**
 * Inline-positioned sidebar shell. Mirrors the data attributes
 * (`data-state`, `data-collapsible`) and the `.group` marker that
 * `SidebarMenuButton` / `SidebarMenuAction` / `SidebarGroupLabel`
 * children rely on for their `group-data-[collapsible=icon]:*`
 * selectors, but uses plain flow layout instead of the upstream
 * `Sidebar` primitive's `fixed inset-y-0 h-svh` chrome — so embedding
 * `<ChatApp history>` below a host header doesn't make the sidebar
 * overlap the viewport edges.
 */
function InlineSidebar({ children }: { children: ReactNode }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <aside
      data-slot="sidebar"
      data-state={state}
      data-collapsible={collapsed ? "icon" : ""}
      data-side="left"
      className={cn(
        "group bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200 ease-linear",
        collapsed ? "w-(--sidebar-width-icon)" : "w-(--sidebar-width)",
      )}
    >
      {children}
    </aside>
  );
}

/** Sidebar header with the title (hidden in icon mode) and toggle. */
function HistorySidebarHeader() {
  const { state, toggleSidebar } = useSidebar();
  const expanded = state === "expanded";
  return (
    <SidebarHeader
      className={cn(
        "h-[44px] flex-row items-center gap-2 px-2 py-0",
        expanded ? "justify-between" : "justify-center",
      )}
    >
      {expanded && (
        <span className="text-foreground px-1 text-base font-semibold">
          Chat
        </span>
      )}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
        className="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex h-7 w-7 cursor-pointer items-center justify-center rounded-md"
      >
        <DbIcon
          icon={expanded ? SidebarCollapseIcon : SidebarExpandIcon}
          size={16}
          color="muted"
        />
      </button>
    </SidebarHeader>
  );
}

/**
 * Single-conversation chat body. Owns the `useChat` lifecycle, approvals
 * map, scroll-stick logic, and renders the messages list + composer.
 * Re-keyed by {@link ChatAppWithHistory} on thread switches so seed
 * `messages` and `threadId` are captured at mount.
 */
function ChatBody<TMessage extends UIMessage = UIMessage>({
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
}: Omit<ChatAppProps<TMessage>, "history">) {
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

  const approveApi = useMemo(
    () => deriveApproveUrl(api, approveUrl),
    [api, approveUrl],
  );
  const { submit: submitApproval } = useSubmitApproval({ api: approveApi });

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
          await submitApproval(decision);
        }
        setState(decision.decision === "approve" ? "approved" : "denied");
      } catch (err) {
        // Roll back to pending so the user can retry.
        console.error("[ChatApp] approval decision failed", err);
        setState("pending");
      }
    },
    [onApprovalDecision, submitApproval],
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

  // See note in `ChatAppWithHistory` — re-target radix portals so they
  // inherit the chat-scoped CSS variables.
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
    null,
  );

  return (
    <div
      ref={setPortalContainer}
      data-appkit-chat=""
      className={cn("bg-background flex h-full min-h-0 flex-col", className)}
    >
      <PortalContainerProvider container={portalContainer}>
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
                <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
                  {chat.error.message}
                </div>
              </div>
            )}
            <div className="sticky bottom-0 z-10 mx-auto w-full max-w-3xl px-2 pb-3 md:px-4 md:pb-4">
              {composer}
            </div>
          </>
        )}
      </PortalContainerProvider>
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
