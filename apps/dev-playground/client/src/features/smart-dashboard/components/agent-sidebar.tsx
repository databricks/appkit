import { BrainIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentStream } from "../hooks/use-agent-stream";
import type { KPIData } from "../hooks/use-dashboard-data";
import { AnomalyCard } from "./anomaly-card";
import { InsightCard } from "./insight-card";

interface Insight {
  title: string;
  description: string;
}

interface Anomaly {
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
}

interface AgentSidebarProps {
  kpis: KPIData | null;
  kpisLoaded: boolean;
}

function parseAgentJSON<T>(content: string): T[] {
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    /* skip */
  }
  return [];
}

function buildKPISummary(kpis: KPIData): string {
  return [
    `Total trips: ${kpis.total_trips.toLocaleString()}`,
    `Average fare: $${kpis.avg_fare}`,
    `Average distance: ${kpis.avg_distance} miles`,
    `Fare range: $${kpis.min_fare} - $${kpis.max_fare}`,
    `Top pickup zone: ${kpis.top_pickup_zone} (${kpis.top_zone_trips.toLocaleString()} trips)`,
  ].join(", ");
}

export function AgentSidebar({ kpis, kpisLoaded }: AgentSidebarProps) {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const hasFired = useRef(false);

  const insightsStream = useAgentStream({ agentName: "insights" });
  const anomalyStream = useAgentStream({ agentName: "anomaly" });

  const insightsRef = useRef(insightsStream);
  insightsRef.current = insightsStream;
  const anomalyRef = useRef(anomalyStream);
  anomalyRef.current = anomalyStream;
  const kpisRef = useRef(kpis);
  kpisRef.current = kpis;

  const analyze = useCallback(() => {
    const currentKpis = kpisRef.current;
    if (!currentKpis) return;
    const summary = buildKPISummary(currentKpis);
    setInsights([]);
    setAnomalies([]);
    insightsRef.current.reset();
    anomalyRef.current.reset();
    insightsRef.current.send(
      `Here are the current taxi trip metrics: ${summary}. Analyze for interesting patterns and insights.`,
    );
    anomalyRef.current.send(
      `Here are the current taxi trip metrics: ${summary}. Check for anomalies, outliers, or unusual patterns.`,
    );
  }, []);

  useEffect(() => {
    if (kpisLoaded && kpis && !hasFired.current) {
      hasFired.current = true;
      analyze();
    }
  }, [kpisLoaded, kpis, analyze]);

  useEffect(() => {
    if (!insightsStream.isLoading && insightsStream.content) {
      setInsights(parseAgentJSON<Insight>(insightsStream.content));
    }
  }, [insightsStream.isLoading, insightsStream.content]);

  useEffect(() => {
    if (!anomalyStream.isLoading && anomalyStream.content) {
      setAnomalies(parseAgentJSON<Anomaly>(anomalyStream.content));
    }
  }, [anomalyStream.isLoading, anomalyStream.content]);

  const isAnalyzing = insightsStream.isLoading || anomalyStream.isLoading;

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <BrainIcon className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">
            Agent Feed
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            hasFired.current = false;
            analyze();
          }}
          disabled={isAnalyzing}
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          aria-label="Refresh analysis"
        >
          <RefreshCwIcon
            className={`h-3.5 w-3.5 ${isAnalyzing ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {isAnalyzing && insights.length === 0 && anomalies.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Loader2Icon className="h-5 w-5 animate-spin mb-2" />
            <p className="text-xs">Analyzing data...</p>
          </div>
        )}

        {!isAnalyzing &&
          insights.length === 0 &&
          anomalies.length === 0 &&
          !kpisLoaded && (
            <p className="text-xs text-muted-foreground text-center py-8">
              Loading dashboard data...
            </p>
          )}

        {!isAnalyzing &&
          insights.length === 0 &&
          anomalies.length === 0 &&
          kpisLoaded && (
            <p className="text-xs text-muted-foreground text-center py-8">
              Click refresh to analyze the data
            </p>
          )}

        {insights.map((insight) => (
          <InsightCard
            key={`insight-${insight.title}`}
            title={insight.title}
            description={insight.description}
          />
        ))}

        {anomalies.map((anomaly) => (
          <AnomalyCard
            key={`anomaly-${anomaly.title}`}
            title={anomaly.title}
            description={anomaly.description}
            severity={anomaly.severity}
          />
        ))}
      </div>
    </div>
  );
}
