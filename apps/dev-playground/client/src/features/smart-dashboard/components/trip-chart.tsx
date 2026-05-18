import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Highlight } from "../hooks/use-action-dispatcher";
import { useChartColors } from "../hooks/use-chart-colors";
import type { TripOverTime } from "../hooks/use-dashboard-data";

interface TripChartProps {
  data: TripOverTime[];
  highlights: Highlight[];
  isLoading: boolean;
}

const HIGHLIGHT_COLORS: Record<Highlight["color"], string> = {
  blue: "rgba(96, 165, 250, 0.25)",
  red: "rgba(248, 113, 113, 0.25)",
  yellow: "rgba(250, 204, 21, 0.25)",
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function findClosestDate(
  target: string,
  dates: string[],
  direction: "start" | "end",
): string | undefined {
  if (dates.length === 0) return undefined;
  const t = new Date(target).getTime();
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const d of dates) {
    const dt = new Date(d).getTime();
    const dist = Math.abs(dt - t);
    const valid = direction === "start" ? dt <= t : dt >= t;
    if (valid && dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best ?? dates[direction === "start" ? 0 : dates.length - 1];
}

export function TripChart({ data, highlights, isLoading }: TripChartProps) {
  const gradientId = useId();
  const c = useChartColors();
  const dates = data.map((d) => d.trip_date);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-medium text-muted-foreground mb-4">
          Trips Over Time
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
        Trips Over Time
      </h3>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart
          data={data}
          margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={c.primary} stopOpacity={0.3} />
              <stop offset="95%" stopColor={c.primary} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="trip_date"
            tickFormatter={formatDate}
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
            labelFormatter={formatDate}
            formatter={(value: number) => [value.toLocaleString(), "Trips"]}
          />
          {highlights.map((h, i) => {
            const x1 = findClosestDate(h.start, dates, "start");
            const x2 = findClosestDate(h.end, dates, "end");
            if (!x1 || !x2) return null;
            return (
              <ReferenceArea
                key={`${h.start}-${h.end}-${i}`}
                x1={x1}
                x2={x2}
                fill={HIGHLIGHT_COLORS[h.color]}
                label={
                  h.label
                    ? { value: h.label, position: "top", fontSize: 11 }
                    : undefined
                }
              />
            );
          })}
          <Area
            type="monotone"
            dataKey="trip_count"
            stroke={c.primary}
            fill={`url(#${gradientId})`}
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
