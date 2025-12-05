import { sql } from "@databricks/app-kit-ui/js";
import { BarChart } from "@databricks/app-kit-ui/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface UsageTrendsChartProps {
  groupBy: "default" | "app" | "user";
  onGroupByChange: (groupBy: "default" | "app" | "user") => void;
  queryParams: Record<string, any>;
}

export function UsageTrendsChart({
  groupBy,
  onGroupByChange,
  queryParams,
}: UsageTrendsChartProps) {
  const spendDataParams = {
    ...queryParams,
    groupBy: sql.string(groupBy),
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>Usage Trends</CardTitle>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Group by</span>
            <Select value={groupBy} onValueChange={onGroupByChange}>
              <SelectTrigger className="w-[130px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="app">By App</SelectItem>
                <SelectItem value="user">By User</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <BarChart queryKey="spend_data" parameters={spendDataParams} />
      </CardContent>
    </Card>
  );
}
