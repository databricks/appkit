import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

interface UsageTrendsChartProps {
  data: Array<{ date: string; spend: number }>;
  loading: boolean;
  error: string | null;
  groupBy: "default" | "app" | "user";
  onGroupByChange: (groupBy: "default" | "app" | "user") => void;
}

const chartConfig = {
  spend: {
    label: "Total Spend",
    color: "hsl(160, 84%, 39%)",
  },
};

export function UsageTrendsChart({
  data,
  loading,
  error,
  groupBy,
  onGroupByChange,
}: UsageTrendsChartProps) {
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
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-[300px] w-full" />
          </div>
        ) : error ? (
          <div className="p-10 text-center">
            <p className="text-sm text-destructive">
              Error loading data: {error}
            </p>
          </div>
        ) : data.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No data available for the selected period
            </p>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[300px] w-full">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => {
                  const date = new Date(value);
                  return date.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  });
                }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => `$${value}`}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar
                dataKey="spend"
                fill="var(--color-spend)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
