import { BrainIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Highlight } from "../hooks/use-action-dispatcher";
import { useAgentStream } from "../hooks/use-agent-stream";
import type { DashboardFilters, KPIData } from "../hooks/use-dashboard-data";
import {
  type FeedAction,
  type FeedAnomaly,
  type FeedInsight,
  parseFeedAnomalies,
  parseFeedInsights,
} from "../lib/feed-actions";
import { ActionableCard } from "./actionable-card";

interface AgentSidebarProps {
  kpis: KPIData | null;
  kpisLoaded: boolean;
  filters: DashboardFilters;
  highlights: Highlight[];
  /** Dispatches a structured action back to the dashboard without an LLM round-trip. */
  onAction: (action: FeedAction) => void;
  /** Fires when the user clicks an `ask` chip — routes to the main chat drawer. */
  onAsk: (prompt: string) => void;
}

function buildKPISummary(
  kpis: KPIData,
  filters: DashboardFilters,
  highlights: Highlight[],
): string {
  const parts = [
    `Total trips: ${kpis.total_trips.toLocaleString()}`,
    `Avg fare: $${kpis.avg_fare}`,
    `Avg distance: ${kpis.avg_distance} mi`,
    `Fare range: $${kpis.min_fare}–$${kpis.max_fare}`,
    `Top pickup zone: ${kpis.top_pickup_zone} (${kpis.top_zone_trips.toLocaleString()} trips)`,
  ];
  const activeFilters = Object.entries(filters)
    .filter(([, v]) => typeof v === "string" && v)
    .map(([k, v]) => `${k}=${v}`);
  if (activeFilters.length > 0) {
    parts.push(`Active filters: ${activeFilters.join(", ")}`);
  } else {
    parts.push("Active filters: none (full 2016 dataset)");
  }
  if (highlights.length > 0) {
    parts.push(
      `Highlights: ${highlights
        .map(
          (h) =>
            `${h.start}→${h.end}${h.label ? ` (${h.label})` : ""} [${h.color}]`,
        )
        .join(", ")}`,
    );
  }
  return parts.join(". ");
}

/**
 * Debounce helper so a rapid sequence of filter/highlight changes collapses
 * into one ephemeral agent re-run. 700ms is short enough to feel responsive
 * but long enough to coalesce a typical click+click interaction.
 */
function useDebouncedSignal(dep: string, delayMs: number): string {
  const [stable, setStable] = useState(dep);
  useEffect(() => {
    const t = setTimeout(() => setStable(dep), delayMs);
    return () => clearTimeout(t);
  }, [dep, delayMs]);
  return stable;
}

const SUGGESTED_FOLLOWUPS = [
  "Compare this slice to the prior month.",
  "What ZIPs show the highest fare-per-mile?",
  "Were there any days with abnormal trip counts?",
];

export function AgentSidebar({
  kpis,
  kpisLoaded,
  filters,
  highlights,
  onAction,
  onAsk,
}: AgentSidebarProps) {
  const [insights, setInsights] = useState<FeedInsight[]>([]);
  const [anomalies, setAnomalies] = useState<FeedAnomaly[]>([]);

  const insightsStream = useAgentStream({ agentName: "insights" });
  const anomalyStream = useAgentStream({ agentName: "anomaly" });

  // Hold the latest stream handles + context refs so `analyze()` is stable
  // but still reads current state.
  const insightsRef = useRef(insightsStream);
  insightsRef.current = insightsStream;
  const anomalyRef = useRef(anomalyStream);
  anomalyRef.current = anomalyStream;
  const ctxRef = useRef({ kpis, filters, highlights });
  ctxRef.current = { kpis, filters, highlights };

  const analyze = useCallback(() => {
    const { kpis: currentKpis, filters: f, highlights: h } = ctxRef.current;
    if (!currentKpis) return;
    const summary = buildKPISummary(currentKpis, f, h);
    setInsights([]);
    setAnomalies([]);
    insightsRef.current.reset();
    anomalyRef.current.reset();
    insightsRef.current.send(
      `Current NYC taxi dashboard state: ${summary}. Surface the most interesting patterns and insights with actionable chips.`,
    );
    anomalyRef.current.send(
      `Current NYC taxi dashboard state: ${summary}. Identify anomalies, outliers, or suspicious patterns with actionable chips.`,
    );
  }, []);

  // Initial fire once KPIs load.
  const hasFired = useRef(false);
  useEffect(() => {
    if (kpisLoaded && kpis && !hasFired.current) {
      hasFired.current = true;
      analyze();
    }
  }, [kpisLoaded, kpis, analyze]);

  // Re-run whenever filters or highlights settle into a new value. Encoded as
  // a string so useEffect gets a primitive dep and the debounce works off
  // structural equality, not object identity.
  const stateSignal = useMemo(
    () =>
      JSON.stringify({
        f: filters,
        h: highlights.map((hh) => `${hh.start}-${hh.end}-${hh.color}`),
      }),
    [filters, highlights],
  );
  const debouncedSignal = useDebouncedSignal(stateSignal, 700);
  const lastAnalyzedSignal = useRef(stateSignal);
  useEffect(() => {
    if (!kpisLoaded || !kpis) return;
    if (!hasFired.current) return; // initial fire is in the other effect
    if (debouncedSignal === lastAnalyzedSignal.current) return;
    lastAnalyzedSignal.current = debouncedSignal;
    analyze();
  }, [debouncedSignal, kpisLoaded, kpis, analyze]);

  useEffect(() => {
    if (!insightsStream.isLoading && insightsStream.content) {
      setInsights(parseFeedInsights(insightsStream.content));
    }
  }, [insightsStream.isLoading, insightsStream.content]);

  useEffect(() => {
    if (!anomalyStream.isLoading && anomalyStream.content) {
      setAnomalies(parseFeedAnomalies(anomalyStream.content));
    }
  }, [anomalyStream.isLoading, anomalyStream.content]);

  const isAnalyzing = insightsStream.isLoading || anomalyStream.isLoading;
  const totalFindings = insights.length + anomalies.length;

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <BrainIcon className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">
            Agent Feed
          </span>
          {isAnalyzing ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">
              <Loader2Icon className="h-2.5 w-2.5 animate-spin" />
              analyzing
            </span>
          ) : totalFindings > 0 ? (
            <span className="text-[10px] font-medium text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
              {insights.length}
              <span className="text-muted-foreground/70"> insights · </span>
              {anomalies.length}
              <span className="text-muted-foreground/70"> anomalies</span>
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={analyze}
          disabled={isAnalyzing}
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          aria-label="Refresh analysis"
          title="Re-run insights & anomaly agents"
        >
          <RefreshCwIcon
            className={`h-3.5 w-3.5 ${isAnalyzing ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {isAnalyzing && totalFindings === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Loader2Icon className="h-5 w-5 animate-spin mb-2" />
            <p className="text-xs">Analyzing data…</p>
          </div>
        )}

        {!isAnalyzing && totalFindings === 0 && !kpisLoaded && (
          <p className="text-xs text-muted-foreground text-center py-8">
            Loading dashboard data…
          </p>
        )}

        {!isAnalyzing && totalFindings === 0 && kpisLoaded && (
          <p className="text-xs text-muted-foreground text-center py-8">
            No findings for this slice — try widening the filters.
          </p>
        )}

        {insights.map((insight, i) => (
          <ActionableCard
            key={`insight-${i}-${insight.title}`}
            variant="insight"
            title={insight.title}
            description={insight.description}
            actions={insight.actions ?? []}
            onAction={onAction}
            onAsk={onAsk}
          />
        ))}

        {anomalies.map((anomaly, i) => (
          <ActionableCard
            key={`anomaly-${i}-${anomaly.title}`}
            variant="anomaly"
            severity={anomaly.severity}
            title={anomaly.title}
            description={anomaly.description}
            actions={anomaly.actions ?? []}
            onAction={onAction}
            onAsk={onAsk}
          />
        ))}
      </div>

      {kpisLoaded && (
        <div className="border-t border-border px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            Try asking
          </p>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_FOLLOWUPS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onAsk(prompt)}
                className="text-[11px] px-2 py-1 rounded-md border border-border bg-background hover:bg-muted text-foreground/80 hover:text-foreground transition-colors"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
