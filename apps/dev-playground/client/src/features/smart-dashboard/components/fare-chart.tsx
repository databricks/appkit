import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "../hooks/use-chart-colors";
import type { FareBucket } from "../hooks/use-dashboard-data";

interface FareChartProps {
  data: FareBucket[];
  isLoading: boolean;
}

export function FareChart({ data, isLoading }: FareChartProps) {
  const c = useChartColors();

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-medium text-muted-foreground mb-4">
          Fare Distribution
        </h3>
        <div className="h-[260px] flex items-center justify-center">
          <div className="h-full w-full animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h3 className="text-sm font-medium text-muted-foreground mb-4">
        Fare Distribution
      </h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart
          data={data}
          margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="fare_bucket"
            tick={{ fontSize: 11, fill: c.axis }}
            stroke={c.grid}
          />
          <YAxis
            tick={{ fontSize: 11, fill: c.axis }}
            stroke={c.grid}
            tickFormatter={(v: number) =>
              v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)
            }
          />
          <Tooltip
            contentStyle={{
              backgroundColor: c.tooltipBg,
              color: c.tooltipFg,
              border: `1px solid ${c.grid}`,
              borderRadius: "8px",
              fontSize: "12px",
            }}
            labelStyle={{ color: c.tooltipFg }}
            itemStyle={{ color: c.tooltipFg }}
            formatter={(value: number, name: string) => {
              if (name === "trip_count")
                return [value.toLocaleString(), "Trips"];
              return [value, name];
            }}
          />
          <Bar dataKey="trip_count" fill={c.secondary} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
