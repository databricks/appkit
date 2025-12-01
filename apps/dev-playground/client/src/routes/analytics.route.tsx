import { useAnalyticsQuery } from "@databricks/app-kit-ui/react";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  AnalyticsHeader,
  FilterBar,
  SummaryCards,
  TopContributorsChart,
  UntaggedAppsTable,
  UsageTrendsChart,
} from "@/components/analytics";
import type { Aggregation, DashboardFilters } from "@/lib/types";
import { buildWorkflowParams } from "@/lib/utils/filter-utils";

export const Route = createFileRoute("/analytics")({
  component: AnalyticsRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

function AnalyticsRoute() {
  const [filters, setFilters] = useState<DashboardFilters>({
    apps: "all",
    creator: "all",
    tags: "all",
    dateRange: "last30",
  });
  const [aggregation, setAggregation] = useState<Aggregation>({
    period: "daily",
  });
  const [usageTrendsGroupBy, setUsageTrendsGroupBy] = useState<
    "default" | "app" | "user"
  >("default");
  const [topContributorsGroupBy, setTopContributorsGroupBy] = useState<
    "app" | "user"
  >("user");

  const queryParams = useMemo(() => {
    const params = buildWorkflowParams(filters, aggregation);
    return params.filters;
  }, [filters, aggregation]);

  const summaryParams = useMemo(() => {
    return {
      startDate: queryParams.startDate,
      endDate: queryParams.endDate,
      aggregationLevel: queryParams.aggregationLevel,
    };
  }, [queryParams]);

  const {
    data: summaryDataRaw,
    loading: summaryLoading,
    error: summaryError,
  } = useAnalyticsQuery("spend_summary", summaryParams);

  const { data: appsListData } = useAnalyticsQuery("apps_list", {});

  const untaggedAppsParams = useMemo(() => {
    return {
      startDate: queryParams.startDate,
      endDate: queryParams.endDate,
      aggregationLevel: queryParams.aggregationLevel,
    };
  }, [queryParams]);

  const {
    data: untaggedAppsData,
    loading: untaggedAppsLoading,
    error: untaggedAppsError,
  } = useAnalyticsQuery("untagged_apps", untaggedAppsParams);

  const metrics = useMemo(() => {
    if (!summaryDataRaw || summaryDataRaw.length === 0) {
      return { total: 0, average: 0, forecasted: 0 };
    }
    return summaryDataRaw[0];
  }, [summaryDataRaw]);

  const appsList = useMemo(() => {
    if (!appsListData || appsListData.length === 0) {
      return [];
    }
    return appsListData.map((app, index) => ({
      id: `${app.id}-${app.creator}-${index}`,
      name: app.name,
      creator: app.creator,
      spend: Math.round(app.totalSpend),
      status: "unknown" as const,
      tags: app.tags ?? [],
      lastRun: app.createdAt,
    }));
  }, [appsListData]);

  const untaggedAppsList = useMemo(() => {
    if (!untaggedAppsData || untaggedAppsData.length === 0) return [];
    return untaggedAppsData.map((app, index) => ({
      id: `${app.app_name}-${app.creator}-${index}`,
      name: app.app_name,
      creator: app.creator,
      spend: Math.round(app.total_cost_usd),
      avgSpend: Math.round(app.avg_period_cost_usd),
      status: "untagged" as const,
      tags: [],
      lastRun: "",
    }));
  }, [untaggedAppsData]);

  return (
    <div className="min-h-[calc(100vh-73px)] bg-gray-50">
      <AnalyticsHeader />

      <main className="max-w-7xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-6">
          <FilterBar
            filters={filters}
            aggregation={aggregation}
            appsList={appsList}
            onFiltersChange={setFilters}
            onAggregationChange={setAggregation}
          />

          <SummaryCards
            metrics={metrics}
            loading={summaryLoading}
            error={summaryError}
            filters={filters}
            aggregation={aggregation}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <UsageTrendsChart
              queryParams={queryParams}
              groupBy={usageTrendsGroupBy}
              onGroupByChange={(value) =>
                setUsageTrendsGroupBy(value as "default" | "app" | "user")
              }
            />

            <TopContributorsChart
              queryParams={queryParams}
              groupBy={topContributorsGroupBy}
              onGroupByChange={(value) =>
                setTopContributorsGroupBy(value as "app" | "user")
              }
            />
          </div>

          <UntaggedAppsTable
            data={untaggedAppsList}
            loading={untaggedAppsLoading}
            error={untaggedAppsError}
          />
        </div>
      </main>
    </div>
  );
}
