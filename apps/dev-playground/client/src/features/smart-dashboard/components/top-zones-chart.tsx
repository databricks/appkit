import { useMemo, useState } from "react";
import { useChartColors } from "../hooks/use-chart-colors";
import type { TopZoneRow } from "../hooks/use-dashboard-data";

export interface HighlightedZone {
  zip: string;
  label?: string;
}

interface TopZonesChartProps {
  data: TopZoneRow[];
  isLoading: boolean;
  /** Zones with a visible emphasis ring — driven by the `highlight_zone` tool. */
  highlightedZones: HighlightedZone[];
  /** Click on a bar → filter the dashboard to that zip. */
  onZipClick?: (zip: string) => void;
}

type Metric = "trips" | "revenue";

/**
 * Horizontal leaderboard chart for pickup ZIPs. Hand-rolled divs rather than
 * recharts' BarChart because:
 *  - we want per-row click handlers and a distinct ring for highlighted zones;
 *  - the bars need a stable text overlay (ZIP + value) that doesn't fight with
 *    recharts' label positioning logic;
 *  - 10 rows max means flexbox is trivially faster than a full chart engine.
 */
export function TopZonesChart({
  data,
  isLoading,
  highlightedZones,
  onZipClick,
}: TopZonesChartProps) {
  const c = useChartColors();
  const [metric, setMetric] = useState<Metric>("trips");

  const { rows, max } = useMemo(() => {
    const sorted = [...data].sort((a, b) =>
      metric === "trips"
        ? b.trip_count - a.trip_count
        : b.total_revenue - a.total_revenue,
    );
    const m = sorted.reduce(
      (acc, r) =>
        Math.max(acc, metric === "trips" ? r.trip_count : r.total_revenue),
      0,
    );
    return { rows: sorted, max: m };
  }, [data, metric]);

  const highlightSet = useMemo(
    () => new Map(highlightedZones.map((h) => [h.zip, h.label ?? ""])),
    [highlightedZones],
  );

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-medium text-muted-foreground mb-4">
          Top Pickup Zones
        </h3>
        <div className="h-[260px] animate-pulse rounded bg-muted" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-muted-foreground">
          Top Pickup Zones
        </h3>
        <div className="inline-flex rounded-md border border-border p-0.5 bg-muted/40 text-[11px]">
          <button
            type="button"
            onClick={() => setMetric("trips")}
            className={`px-2 py-0.5 rounded transition-colors ${
              metric === "trips"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Trips
          </button>
          <button
            type="button"
            onClick={() => setMetric("revenue")}
            className={`px-2 py-0.5 rounded transition-colors ${
              metric === "revenue"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Revenue
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="h-[260px] flex items-center justify-center text-xs text-muted-foreground">
          No zones in range
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const value =
              metric === "trips" ? row.trip_count : row.total_revenue;
            const pct = max > 0 ? (value / max) * 100 : 0;
            const isHighlighted = highlightSet.has(row.pickup_zip);
            const highlightLabel = highlightSet.get(row.pickup_zip);

            return (
              <button
                key={row.pickup_zip}
                type="button"
                onClick={() => onZipClick?.(row.pickup_zip)}
                disabled={!onZipClick}
                className={`w-full text-left group relative rounded-md transition-all ${
                  isHighlighted
                    ? "ring-2 ring-amber-400/70 dark:ring-amber-300/70"
                    : ""
                } ${onZipClick ? "hover:bg-muted/40" : ""}`}
                title={
                  onZipClick
                    ? `Filter dashboard to pickup ZIP ${row.pickup_zip}`
                    : row.pickup_zip
                }
              >
                <div className="flex items-center gap-3 px-2 py-1.5">
                  <span className="text-xs font-mono font-medium w-12 tabular-nums text-foreground">
                    {row.pickup_zip}
                  </span>
                  <div className="flex-1 h-5 rounded bg-muted/50 overflow-hidden relative">
                    <div
                      className="h-full rounded transition-[width] duration-500"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: isHighlighted
                          ? "hsl(38, 92%, 55%)"
                          : c.secondary,
                        opacity: 0.85,
                      }}
                    />
                    {highlightLabel && (
                      <span className="absolute inset-y-0 right-2 flex items-center text-[10px] font-medium text-amber-900 dark:text-amber-100">
                        {highlightLabel}
                      </span>
                    )}
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground w-20 text-right">
                    {metric === "trips"
                      ? value.toLocaleString()
                      : `$${Math.round(value).toLocaleString()}`}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
