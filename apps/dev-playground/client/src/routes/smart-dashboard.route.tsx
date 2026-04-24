import { createFileRoute } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { ActiveFilters } from "./smart-dashboard/components/active-filters";
import { AgentSidebar } from "./smart-dashboard/components/agent-sidebar";
import { FareChart } from "./smart-dashboard/components/fare-chart";
import { KPICards } from "./smart-dashboard/components/kpi-cards";
import { QuerySection } from "./smart-dashboard/components/query-section";
import { TripChart } from "./smart-dashboard/components/trip-chart";
import type { Highlight } from "./smart-dashboard/hooks/use-action-dispatcher";
import { useActionDispatcher } from "./smart-dashboard/hooks/use-action-dispatcher";
import type { DashboardFilters } from "./smart-dashboard/hooks/use-dashboard-data";
import { useDashboardData } from "./smart-dashboard/hooks/use-dashboard-data";

export const Route = createFileRoute("/smart-dashboard")({
  component: SmartDashboardRoute,
});

function SmartDashboardRoute() {
  const [filters, setFilters] = useState<DashboardFilters>({});
  const [highlights, setHighlights] = useState<Highlight[]>([]);

  const { kpis, tripsOverTime, fareDistribution, isLoading } =
    useDashboardData(filters);

  const handleFilterChange = useCallback((newFilters: DashboardFilters) => {
    setFilters(newFilters);
  }, []);

  const handleHighlight = useCallback((highlight: Highlight) => {
    setHighlights((prev) => [...prev, highlight]);
  }, []);

  const { handleEvent } = useActionDispatcher({
    onFilterChange: handleFilterChange,
    onHighlight: handleHighlight,
    currentFilters: filters,
  });

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
        <header className="flex items-center gap-3 mb-5">
          <div className="rounded-lg bg-primary/10 p-2">
            <LayoutDashboardIcon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">
              Smart Dashboard
            </h1>
            <p className="text-xs text-muted-foreground">
              NYC Taxi Analytics — powered by 3 AI agents
            </p>
          </div>
        </header>

        <div className="mb-4">
          <ActiveFilters
            filters={filters}
            onClear={handleClearFilter}
            onClearAll={handleClearAllFilters}
          />
        </div>

        <div className="mb-5">
          <KPICards data={kpis} isLoading={isLoading} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5 mb-5">
          <div className="space-y-5">
            <TripChart
              data={tripsOverTime}
              highlights={highlights}
              isLoading={isLoading}
            />
            <FareChart data={fareDistribution} isLoading={isLoading} />
          </div>
          <div className="lg:h-[580px]">
            <AgentSidebar kpis={kpis} kpisLoaded={!isLoading} />
          </div>
        </div>

        <QuerySection onEvent={handleEvent} />
      </div>
    </div>
  );
}
