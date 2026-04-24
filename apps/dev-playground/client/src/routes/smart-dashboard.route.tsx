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
import { FareChart } from "@/features/smart-dashboard/components/fare-chart";
import { FocusableChart } from "@/features/smart-dashboard/components/focusable-chart";
import { InspectorToggle } from "@/features/smart-dashboard/components/inspector-toggle";
import { KPICards } from "@/features/smart-dashboard/components/kpi-cards";
import { QuerySection } from "@/features/smart-dashboard/components/query-section";
import { QuickActionsBar } from "@/features/smart-dashboard/components/quick-actions-bar";
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

function SmartDashboardRoute() {
  const [filters, setFilters] = useState<DashboardFilters>({});
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  );
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useInspectorShortcuts();

  // Dashboard data is keyed on the *current* filter state; the dispatcher
  // mutates `filters` via setState updaters, so every new filter triggers
  // a re-query automatically.
  const {
    kpis,
    tripsOverTime,
    fareDistribution,
    isLoading: dataLoading,
    error: dataError,
  } = useDashboardData(filters);

  // Dispatcher surfaces actions via `onAction`; toast shows them. A small
  // stream of summaries arrives as the agent makes calls on `.done` events.
  const pushAction = useCallback((summary: string) => {
    setLastAction(summary);
  }, []);

  const pushUnknown = useCallback((name: string, args: unknown) => {
    const argsPreview = typeof args === "string" ? args : JSON.stringify(args);
    setError(
      `Agent emitted an unhandled tool call '${name}' with args ${argsPreview}. Ignoring — the dispatcher only handles the declared dashboard tools.`,
    );
    // Keep the inspector warning visible too:
    // eslint-disable-next-line no-console
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

  // Context prefix is recomputed when filter/highlight state changes, so
  // every `send()` carries the freshest snapshot even though useAgentStream
  // is mounted once at the route level.
  const contextPrefix = useMemo(
    () => buildDashboardContext(filters, highlights),
    [filters, highlights],
  );
  const contextPrefixRef = useRef(contextPrefix);
  contextPrefixRef.current = contextPrefix;

  const handleStreamEvent = useCallback(
    (event: SSEEvent) => {
      handleDispatcherEvent(event);

      if (
        event.type === "appkit.approval_pending" &&
        event.approval_id &&
        event.stream_id &&
        event.tool_name
      ) {
        setPendingApprovals((prev) => [
          ...prev,
          {
            approvalId: event.approval_id as string,
            streamId: event.stream_id as string,
            toolName: event.tool_name as string,
            args: event.args,
            annotations: event.annotations,
          },
        ]);
      }

      if (event.type === "error" && event.error) {
        setError(event.error);
      }
    },
    [handleDispatcherEvent],
  );

  // Lifted to the route so the Quick Actions bar can dispatch through the
  // same pipeline as the chat input. One agent stream, two callers.
  const {
    content,
    isLoading: agentLoading,
    send,
  } = useAgentStream({
    agentName: "query",
    onEvent: handleStreamEvent,
  });

  const dispatchToAgent = useCallback(
    (message: string) => {
      send(message, { contextPrefix: contextPrefixRef.current });
    },
    [send],
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
              NYC Taxi Analytics — powered by agents · press ⌘K for the stream
              inspector
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
          <ActiveFilters
            filters={filters}
            onClear={handleClearFilter}
            onClearAll={handleClearAllFilters}
          />
        </div>

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

        <div className="space-y-4">
          <QuerySection
            onSend={dispatchToAgent}
            content={content}
            isLoading={agentLoading}
          />
          {pendingApprovals.map((approval) => (
            <ApprovalCard
              key={approval.approvalId}
              approval={approval}
              filters={filters}
              highlights={highlights}
              onDecide={decideApproval}
            />
          ))}
        </div>
      </div>

      <InspectorToggle />
      <StreamInspector />
      <ActionToast message={lastAction} />
    </div>
  );
}
