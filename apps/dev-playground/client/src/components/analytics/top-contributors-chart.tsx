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

interface TopContributorsChartProps {
  data: Array<{ name: string; spend: number; percentage: number }>;
  loading: boolean;
  error: string | null;
  groupBy: "app" | "user";
  onGroupByChange: (groupBy: "app" | "user") => void;
}

const chartConfig = {
  spend: {
    label: "Spend",
    color: "hsl(160, 84%, 39%)",
  },
};

export function TopContributorsChart({
  data,
  loading,
  error,
  groupBy,
  onGroupByChange,
}: TopContributorsChartProps) {
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
                <SelectItem value="user">By User</SelectItem>
                <SelectItem value="app">By App</SelectItem>
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
              No contributors data available
            </p>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[300px] w-full">
            <BarChart data={data} layout="vertical" margin={{ left: 120 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `$${value}`}
              />
              <YAxis
                dataKey="name"
                type="category"
                tickLine={false}
                axisLine={false}
                width={110}
                tickFormatter={(value) => {
                  if (value.length > 15) {
                    return `${value.substring(0, 15)}...`;
                  }
                  return value;
                }}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => value}
                    formatter={(value, name) => [
                      `$${value}`,
                      name === "spend" ? "Spend" : name,
                    ]}
                  />
                }
              />
              <Bar
                dataKey="spend"
                fill="var(--color-spend)"
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
