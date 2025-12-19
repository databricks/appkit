import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@databricks/appkit-ui/react";
import type { Aggregation, DashboardFilters } from "@/lib/types";

interface SummaryCardsProps {
  metrics: {
    total: number;
    average: number;
    forecasted: number;
  };
  loading: boolean;
  error: string | null;
  filters: DashboardFilters;
  aggregation: Aggregation;
}

function getDateRangeText(dateRange: string) {
  switch (dateRange) {
    case "ytd":
      return "Year to date";
    case "last30":
      return "Last 30 days";
    case "last7":
      return "Last 7 days";
    default:
      return "Last 30 days";
  }
}

export function SummaryCards({
  metrics,
  loading,
  error,
  filters,
  aggregation,
}: SummaryCardsProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-24 mb-2" />
              <Skeleton className="h-8 w-20 mb-2" />
              <Skeleton className="h-4 w-28" />
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card>
        <CardHeader>
          <CardDescription>Total spend</CardDescription>
          <CardTitle className="text-3xl">
            {error ? "Error" : `$${(metrics.total / 1000).toFixed(1)}K`}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {getDateRangeText(filters.dateRange)}
          </p>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardDescription>Forecasted spend</CardDescription>
          <CardTitle className="text-3xl">
            {error ? "Error" : `$${(metrics.forecasted / 1000).toFixed(1)}K`}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {metrics.forecasted > 0 && metrics.total > 0
              ? `+${(
                  ((metrics.forecasted - metrics.total) / metrics.total) * 100
                ).toFixed(0)}% vs current period`
              : "Next period"}
          </p>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardDescription>Average spend</CardDescription>
          <CardTitle className="text-3xl">
            {error ? "Error" : `$${Math.round(metrics.average)}`}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {aggregation.period === "daily"
              ? "per day"
              : aggregation.period === "weekly"
                ? "per week"
                : "per month"}
          </p>
        </CardHeader>
      </Card>
    </div>
  );
}
