import { createFileRoute } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActionToast } from "@/features/smart-dashboard/components/action-toast";
import { ActiveFilters } from "@/features/smart-dashboard/components/active-filters";
import { AgentSidebar } from "@/features/smart-dashboard/components/agent-sidebar";
import {
  ApprovalCard,
  type PendingApproval,
} from "@/features/smart-dashboard/components/approval-card";
import {
  ChatDrawer,
  type ChatMessage,
} from "@/features/smart-dashboard/components/chat-drawer";
import { FareChart } from "@/features/smart-dashboard/components/fare-chart";
import { FocusableChart } from "@/features/smart-dashboard/components/focusable-chart";
import { InspectorToggle } from "@/features/smart-dashboard/components/inspector-toggle";
import { KPICards } from "@/features/smart-dashboard/components/kpi-cards";
import { QuickActionsBar } from "@/features/smart-dashboard/components/quick-actions-bar";
import {
  type SavedView,
  SavedViewsPanel,
} from "@/features/smart-dashboard/components/saved-views-panel";
import { StreamInspector } from "@/features/smart-dashboard/components/stream-inspector";
import { TripChart } from "@/features/smart-dashboard/components/trip-chart";
import type { Highlight } from "@/features/smart-dashboard/hooks/use-action-dispatcher";
import { useActionDispatcher } from "@/features/smart-dashboard/hooks/use-action-dispatcher";
import type { SSEEvent } from "@/features/smart-dashboard/hooks/use-agent-stream";
import { useAgentStream } from "@/features/smart-dashboard/hooks/use-agent-stream";
import type { DashboardFilters } from "@/features/smart-dashboard/hooks/use-dashboard-data";
import { useDashboardData } from "@/features/smart-dashboard/hooks/use-dashboard-data";
import { useInspectorShortcuts } from "@/features/smart-dashboard/hooks/use-stream-inspector";
import { buildDashboardContext } from "@/features/smart-dashboard/lib/dashboard-context";

export const Route = createFileRoute("/smart-dashboard")({
  component: SmartDashboardRoute,
});

// Lightweight id factory for chat messages. Not using crypto.randomUUID
// because the value is only meaningful for React keys + approval lookup
// inside a single session.
let messageIdCounter = 0;
const nextMessageId = (): string =>
  `msg_${++messageIdCounter}_${Math.random().toString(36).slice(2, 8)}`;

function SmartDashboardRoute() {
  const [filters, setFilters] = useState<DashboardFilters>({});
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  );
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Multi-turn chat history. Messages accumulate across sends so the user
  // can scroll back through the conversation rather than having the UI
  // wipe itself after every reply.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const activeAssistantIdRef = useRef<string | null>(null);
  const lastUserMessageIdRef = useRef<string | null>(null);

  // Saved-views panel bumps this token after an upload to force a list
  // refresh without pushing props down through ApprovalCard manually.
  const [savedViewsVersion, setSavedViewsVersion] = useState(0);

  useInspectorShortcuts();

  const {
    kpis,
    tripsOverTime,
    fareDistribution,
    isLoading: dataLoading,
    error: dataError,
  } = useDashboardData(filters);

  const pushAction = useCallback((summary: string) => {
    setLastAction(summary);
  }, []);

  const pushUnknown = useCallback((name: string, args: unknown) => {
    const argsPreview = typeof args === "string" ? args : JSON.stringify(args);
    setError(
      `Agent emitted an unhandled tool call '${name}' with args ${argsPreview}. Ignoring.`,
    );
    console.warn(`[dispatcher] unknown/invalid tool '${name}':`, args);
  }, []);

  const handleFilterUpdate = useCallback(
    (updater: (prev: DashboardFilters) => DashboardFilters) => {
      setFilters(updater);
    },
    [],
  );
  const handleAddHighlight = useCallback((h: Highlight) => {
    setHighlights((prev) => [...prev, h]);
  }, []);
  const handleClearFilters = useCallback(() => setFilters({}), []);
  const handleClearHighlights = useCallback(() => setHighlights([]), []);

  const { handleEvent: handleDispatcherEvent } = useActionDispatcher({
    onFilterUpdate: handleFilterUpdate,
    onAddHighlight: handleAddHighlight,
    onClearFilters: handleClearFilters,
    onClearHighlights: handleClearHighlights,
    onAction: pushAction,
    onUnknownTool: pushUnknown,
  });

  const decideApproval = useCallback(
    async (approvalId: string, decision: "approve" | "deny") => {
      const approval = pendingApprovals.find(
        (a) => a.approvalId === approvalId,
      );
      if (!approval) return;
      try {
        await fetch("/api/agents/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            streamId: approval.streamId,
            approvalId,
            decision,
          }),
        });
      } catch (e) {
        setError(
          `Approval failed: ${e instanceof Error ? e.message : "unknown"}`,
        );
      } finally {
        setPendingApprovals((prev) =>
          prev.filter((a) => a.approvalId !== approvalId),
        );
      }
    },
    [pendingApprovals],
  );

  const contextPrefix = useMemo(
    () => buildDashboardContext(filters, highlights),
    [filters, highlights],
  );
  const contextPrefixRef = useRef(contextPrefix);
  contextPrefixRef.current = contextPrefix;

  const handleStreamEvent = useCallback(
    (event: SSEEvent) => {
      handleDispatcherEvent(event);

      // Capture pending approvals and pin them to the user turn that
      // triggered them so the ChatDrawer can render the card inline.
      if (
        event.type === "appkit.approval_pending" &&
        event.approval_id &&
        event.stream_id &&
        event.tool_name
      ) {
        const pinnedToMessageId = lastUserMessageIdRef.current;
        setPendingApprovals((prev) => [
          ...prev,
          {
            approvalId: event.approval_id as string,
            streamId: event.stream_id as string,
            toolName: event.tool_name as string,
            args: event.args,
            annotations: event.annotations,
            ...(pinnedToMessageId
              ? { _pinnedToMessageId: pinnedToMessageId }
              : {}),
          } as PendingApproval & { _pinnedToMessageId?: string },
        ]);
      }

      // Stream assistant text into the in-progress assistant message.
      if (event.type === "response.output_text.delta" && event.delta) {
        const id = activeAssistantIdRef.current;
        if (id) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === id
                ? { ...m, content: m.content + (event.delta ?? "") }
                : m,
            ),
          );
        }
      }

      // Finalize the streaming assistant message when the run completes.
      if (event.type === "response.completed") {
        const id = activeAssistantIdRef.current;
        if (id) {
          setMessages((prev) =>
            prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
          );
          activeAssistantIdRef.current = null;
        }
      }

      if (event.type === "error" && event.error) {
        setError(event.error);
      }
    },
    [handleDispatcherEvent],
  );

  const { isLoading: agentLoading, send } = useAgentStream({
    agentName: "query",
    onEvent: handleStreamEvent,
  });

  const dispatchToAgent = useCallback(
    (message: string) => {
      const userMsgId = nextMessageId();
      const assistantMsgId = nextMessageId();
      lastUserMessageIdRef.current = userMsgId;
      activeAssistantIdRef.current = assistantMsgId;
      setMessages((prev) => [
        ...prev,
        { id: userMsgId, role: "user", content: message },
        { id: assistantMsgId, role: "assistant", content: "", streaming: true },
      ]);
      send(message, { contextPrefix: contextPrefixRef.current });
    },
    [send],
  );

  const handleLoadSavedView = useCallback(
    (view: SavedView) => {
      const name = view.metadata.name ?? "saved view";
      dispatchToAgent(`Load the saved view '${name}'`);
    },
    [dispatchToAgent],
  );

  const handleSavedNotification = useCallback(
    (info: { name: string; volumePath: string }) => {
      setLastAction(`Saved "${info.name}" to volume`);
      setSavedViewsVersion((v) => v + 1);
    },
    [],
  );

  const handleClearFilter = useCallback((key: keyof DashboardFilters) => {
    setFilters((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleClearAllFilters = useCallback(() => {
    setFilters({});
    setHighlights([]);
  }, []);

  // Ref to the captured region for save_view. Kept on the dashboard body
  // (not the header/chat) so the screenshot is the analytics surface only.
  const dashboardRef = useRef<HTMLDivElement | null>(null);

  // ApprovalCards render inline in the chat drawer, pinned to the user
  // turn that triggered them. Builds a lookup per render.
  const approvalsByMessage = useMemo(() => {
    const map = new Map<string, PendingApproval[]>();
    for (const a of pendingApprovals) {
      const pinId =
        (a as PendingApproval & { _pinnedToMessageId?: string })
          ._pinnedToMessageId ?? "__loose";
      const arr = map.get(pinId) ?? [];
      arr.push(a);
      map.set(pinId, arr);
    }
    return map;
  }, [pendingApprovals]);

  const approvalCardForMessage = useCallback(
    (messageId: string): React.ReactNode | null => {
      const bucket = approvalsByMessage.get(messageId);
      if (!bucket || bucket.length === 0) return null;
      return (
        <div className="space-y-2">
          {bucket.map((approval) => (
            <ApprovalCard
              key={approval.approvalId}
              approval={approval}
              filters={filters}
              highlights={highlights}
              dashboardRef={dashboardRef}
              onDecide={decideApproval}
              onSaved={handleSavedNotification}
            />
          ))}
        </div>
      );
    },
    [
      approvalsByMessage,
      filters,
      highlights,
      decideApproval,
      handleSavedNotification,
    ],
  );

  const looseApprovals = approvalsByMessage.get("__loose") ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1400px] mx-auto px-4 py-4">
        <header className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-primary/10 p-2">
            <LayoutDashboardIcon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">
              Smart Dashboard
            </h1>
            <p className="text-xs text-muted-foreground">
              NYC Taxi Analytics · ⌘J chat · ⌘K stream inspector
            </p>
          </div>
        </header>

        <div className="mb-4">
          <QuickActionsBar onSend={dispatchToAgent} disabled={agentLoading} />
        </div>

        {(error || dataError) && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-700 dark:text-red-400">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">{error ?? dataError}</div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-red-600/70 hover:text-red-700 font-medium"
              >
                dismiss
              </button>
            </div>
          </div>
        )}

        <div className="mb-4">
          <SavedViewsPanel
            onLoad={handleLoadSavedView}
            refreshToken={savedViewsVersion}
          />
        </div>

        <div className="mb-4">
          <ActiveFilters
            filters={filters}
            onClear={handleClearFilter}
            onClearAll={handleClearAllFilters}
          />
        </div>

        {/* Everything below this ref is what gets captured for save_view. */}
        <div ref={dashboardRef}>
          <div className="mb-5">
            <FocusableChart chartId="kpis">
              <KPICards data={kpis} isLoading={dataLoading} />
            </FocusableChart>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5 mb-5">
            <div className="space-y-5">
              <FocusableChart chartId="trips_over_time">
                <TripChart
                  data={tripsOverTime}
                  highlights={highlights}
                  isLoading={dataLoading}
                />
              </FocusableChart>
              <FocusableChart chartId="fare_distribution">
                <FareChart data={fareDistribution} isLoading={dataLoading} />
              </FocusableChart>
            </div>
            <div className="lg:h-[580px]">
              <AgentSidebar kpis={kpis} kpisLoaded={!dataLoading} />
            </div>
          </div>
        </div>

        {/* Any approvals not pinned to a chat message (defensive fallback). */}
        {looseApprovals.length > 0 && (
          <div className="space-y-3">
            {looseApprovals.map((approval) => (
              <ApprovalCard
                key={approval.approvalId}
                approval={approval}
                filters={filters}
                highlights={highlights}
                dashboardRef={dashboardRef}
                onDecide={decideApproval}
                onSaved={handleSavedNotification}
              />
            ))}
          </div>
        )}
      </div>

      <InspectorToggle />
      <StreamInspector />
      <ActionToast message={lastAction} />

      <ChatDrawer
        messages={messages}
        isLoading={agentLoading}
        onSend={dispatchToAgent}
        approvalCardForMessage={approvalCardForMessage}
        pendingApprovals={pendingApprovals}
        unreadCount={pendingApprovals.length}
      />
    </div>
  );
}
