import type { Aggregation, DashboardFilters } from "@/lib/types";

const ALLOWED_PERIODS = ["day", "week", "month"] as const;
type AggregationPeriod = (typeof ALLOWED_PERIODS)[number];

export function sanitizeAggregationLevel(period: string): AggregationPeriod {
  const normalized =
    period === "daily"
      ? "day"
      : period === "weekly"
        ? "week"
        : period === "monthly"
          ? "month"
          : null;

  if (!normalized || !ALLOWED_PERIODS.includes(normalized)) {
    throw new Error(`Invalid aggregation period: ${period}`);
  }
  return normalized;
}

export function getDateRange(filters: DashboardFilters) {
  if (filters.dateRange === "custom" && filters.customDateRange) {
    return {
      startDate: filters.customDateRange.startDate,
      endDate: filters.customDateRange.endDate,
    };
  }

  const now = new Date();
  let startDate: Date;

  switch (filters.dateRange) {
    case "last7":
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "last30":
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case "ytd":
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  return {
    startDate,
    endDate: now,
  };
}

export function buildWorkflowParams(
  filters: DashboardFilters,
  aggregation: Aggregation,
) {
  const { startDate, endDate } = getDateRange(filters);

  return {
    filters: {
      startDate: startDate.toISOString().split("T")[0],
      endDate: endDate.toISOString().split("T")[0],
      aggregationLevel: sanitizeAggregationLevel(aggregation.period),
      appId: filters.apps !== "all" ? filters.apps : "all",
      creator: filters.creator !== "all" ? filters.creator : "all",
      groupBy: "default",
    },
  };
}
