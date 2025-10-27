import { useAnalyticsQuery } from "@databricks/apps/react";
import { createFileRoute } from "@tanstack/react-router";
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

  const topContributorsParams = useMemo(() => {
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
  } = useAnalyticsQuery<
    Array<{
      total: number;
      average: number;
      forecasted: number;
    }>
  >("spend_summary", summaryParams);

  const { data: appsListData } = useAnalyticsQuery<
    Array<{
      id: string;
      name: string;
      creator: string;
      tags: string;
      totalSpend: number;
      createdAt: string;
    }>
  >("apps_list", {});

  const spendDataParams = useMemo(() => {
    return { ...queryParams, groupBy: usageTrendsGroupBy };
  }, [queryParams, usageTrendsGroupBy]);

  const {
    data: spendData,
    loading: spendLoading,
    error: spendError,
  } = useAnalyticsQuery<
    Array<{
      group_key: string;
      aggregation_period: string;
      cost_usd: number;
    }>
  >("spend_data", spendDataParams);

  const {
    data: topContributorsData,
    loading: topContributorsLoading,
    error: topContributorsError,
  } = useAnalyticsQuery<
    Array<{
      app_name: string;
      total_cost_usd: number;
    }>
  >("top_contributors", topContributorsParams);

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
  } = useAnalyticsQuery<
    Array<{
      app_name: string;
      creator: string;
      total_cost_usd: number;
      avg_period_cost_usd: number;
    }>
  >("untagged_apps", untaggedAppsParams);

  const metrics = useMemo(() => {
    if (!summaryDataRaw || summaryDataRaw.length === 0) {
      return { total: 0, average: 0, forecasted: 0 };
    }
    return summaryDataRaw[0];
  }, [summaryDataRaw]);

  const usageTrendsData = useMemo(() => {
    if (!spendData || spendData.length === 0) return [];
    return spendData.map((item) => ({
      date: item.aggregation_period,
      spend: Math.round(item.cost_usd),
    }));
  }, [spendData]);

  const topContributors = useMemo(() => {
    if (!topContributorsData || topContributorsData.length === 0) return [];
    const total = topContributorsData.reduce(
      (sum, item) => sum + item.total_cost_usd,
      0,
    );
    return topContributorsData.map((item) => ({
      name: item.app_name,
      spend: Math.round(item.total_cost_usd),
      percentage: total > 0 ? (item.total_cost_usd / total) * 100 : 0,
    }));
  }, [topContributorsData]);

  const appsList = useMemo(() => {
    if (!appsListData || appsListData.length === 0) {
      return [];
    }
    return appsListData.map((app, index) => {
      let tags: string[] = [];
      if (app.tags) {
        try {
          if (Array.isArray(app.tags)) {
            tags = app.tags;
          } else if (typeof app.tags === "string") {
            const trimmedTags = app.tags.trim();
            if (trimmedTags.startsWith("[") || trimmedTags.startsWith("{")) {
              tags = JSON.parse(trimmedTags);
            } else if (trimmedTags) {
              tags = trimmedTags
                .split(",")
                .map((t: string) => t.trim())
                .filter(Boolean);
            }
          }
        } catch (error) {
          console.warn("Failed to parse tags for app", app.name, ":", error);
          tags = [];
        }
      }

      return {
        id: `${app.id}-${app.creator}-${index}`,
        name: app.name,
        creator: app.creator,
        spend: Math.round(app.totalSpend),
        status: "unknown" as const,
        tags,
        lastRun: app.createdAt,
      };
    });
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
              data={usageTrendsData}
              loading={spendLoading}
              error={spendError}
              groupBy={usageTrendsGroupBy}
              onGroupByChange={(value) =>
                setUsageTrendsGroupBy(value as "default" | "app" | "user")
              }
            />

            <TopContributorsChart
              data={topContributors}
              loading={topContributorsLoading}
              error={topContributorsError}
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
