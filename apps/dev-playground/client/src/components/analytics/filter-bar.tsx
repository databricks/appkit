import type { Aggregation, DashboardFilters } from "@/lib/types";
import {
  Card,
  CardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@databricks/appkit-ui/react";

interface FilterBarProps {
  filters: DashboardFilters;
  aggregation: Aggregation;
  appsList: Array<{ id: string; name: string }>;
  onFiltersChange: (filters: DashboardFilters) => void;
  onAggregationChange: (aggregation: Aggregation) => void;
}

export function FilterBar({
  filters,
  aggregation,
  appsList,
  onFiltersChange,
  onAggregationChange,
}: FilterBarProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex gap-4 flex-wrap items-end">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Apps</span>
            <Select
              value={filters.apps}
              onValueChange={(value) =>
                onFiltersChange({ ...filters, apps: value })
              }
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select app" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All apps</SelectItem>
                {appsList.map((app) => (
                  <SelectItem key={app.id} value={app.name}>
                    {app.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Date Range</span>
            <Select
              value={filters.dateRange}
              onValueChange={(value) =>
                onFiltersChange({ ...filters, dateRange: value })
              }
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Select range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="last7">Last 7 days</SelectItem>
                <SelectItem value="last30">Last 30 days</SelectItem>
                <SelectItem value="ytd">Year to date</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Aggregation</span>
            <Select
              value={aggregation.period}
              onValueChange={(value) =>
                onAggregationChange({
                  period: value as "daily" | "weekly" | "monthly",
                })
              }
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Select period" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
