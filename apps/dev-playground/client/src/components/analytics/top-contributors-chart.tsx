import { BarChart } from "@databricks/app-kit/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TopContributorsChartProps {
  groupBy: "app" | "user";
  onGroupByChange: (groupBy: "app" | "user") => void;
  queryParams: Record<string, any>;
}

export function TopContributorsChart({
  groupBy,
  onGroupByChange,
  queryParams,
}: TopContributorsChartProps) {
  const topContributorsParams = {
    startDate: queryParams.startDate,
    endDate: queryParams.endDate,
    aggregationLevel: queryParams.aggregationLevel,
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>Top Contributors</CardTitle>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Group by</span>
            <Select value={groupBy} onValueChange={onGroupByChange}>
              <SelectTrigger className="w-[130px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="app">By App</SelectItem>
                <SelectItem value="user">By User</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <BarChart
          queryKey="top_contributors"
          orientation="horizontal"
          parameters={topContributorsParams}
        />
      </CardContent>
    </Card>
  );
}
