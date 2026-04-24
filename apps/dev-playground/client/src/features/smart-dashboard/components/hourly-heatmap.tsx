import { useMemo } from "react";
import type { HeatmapCell } from "../hooks/use-dashboard-data";

interface HourlyHeatmapProps {
  data: HeatmapCell[];
  isLoading: boolean;
  /** Fires when the user clicks a cell. Receives a human-readable slot label
   *  the route typically routes to `dispatchToAgent` so the agent can narrate. */
  onCellClick?: (label: string, cell: HeatmapCell) => void;
}

// Spark's DAYOFWEEK returns 1..7 (Sunday=1, Saturday=7). We render Mon–Sun
// for commuter intuition, so the row order is shifted.
const DAY_ROW_ORDER: Array<{ label: string; dayOfWeek: number }> = [
  { label: "Mon", dayOfWeek: 2 },
  { label: "Tue", dayOfWeek: 3 },
  { label: "Wed", dayOfWeek: 4 },
  { label: "Thu", dayOfWeek: 5 },
  { label: "Fri", dayOfWeek: 6 },
  { label: "Sat", dayOfWeek: 7 },
  { label: "Sun", dayOfWeek: 1 },
];

const FULL_DAY_LABEL: Record<number, string> = {
  1: "Sunday",
  2: "Monday",
  3: "Tuesday",
  4: "Wednesday",
  5: "Thursday",
  6: "Friday",
  7: "Saturday",
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function formatHour(h: number): string {
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  if (h < 12) return `${h}a`;
  return `${h - 12}p`;
}

/**
 * Maps trip_count to an HSL string along the primary → hot gradient. Uses
 * lightness rather than alpha so the cells stay legible on both themes; alpha
 * would wash out the dark-mode variant. Missing cells render as a neutral
 * muted tile rather than "empty" so the grid reads as a matrix at a glance.
 */
function cellColor(value: number, max: number, isDark: boolean): string {
  if (max === 0 || value === 0) {
    return isDark ? "hsl(215, 14%, 22%)" : "hsl(220, 13%, 94%)";
  }
  const t = Math.min(1, value / max);
  if (isDark) {
    const lightness = 18 + t * 42;
    return `hsl(217, 80%, ${lightness}%)`;
  }
  const lightness = 90 - t * 50;
  return `hsl(221, 83%, ${lightness}%)`;
}

function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export function HourlyHeatmap({
  data,
  isLoading,
  onCellClick,
}: HourlyHeatmapProps) {
  const dark = isDarkTheme();

  const { cellByKey, maxCount } = useMemo(() => {
    const map = new Map<string, HeatmapCell>();
    let max = 0;
    for (const c of data) {
      map.set(`${c.day_of_week}-${c.hour_of_day}`, c);
      if (c.trip_count > max) max = c.trip_count;
    }
    return { cellByKey: map, maxCount: max };
  }, [data]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-medium text-muted-foreground mb-4">
          Pickup Heatmap
        </h3>
        <div className="h-[260px] animate-pulse rounded bg-muted" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-muted-foreground">
          Pickup Heatmap
          <span className="ml-2 text-xs text-muted-foreground/70 font-normal">
            day × hour
          </span>
        </h3>
        <span className="text-[10px] text-muted-foreground/70">
          click a cell to investigate
        </span>
      </div>

      <div className="overflow-x-auto">
        <div
          className="grid gap-[2px] text-[10px] text-muted-foreground"
          style={{
            gridTemplateColumns: "28px repeat(24, minmax(18px, 1fr))",
          }}
        >
          <div />
          {HOURS.map((h) => (
            <div
              key={`h-${h}`}
              className="text-center leading-none h-4 flex items-center justify-center"
            >
              {h % 3 === 0 ? formatHour(h) : ""}
            </div>
          ))}

          {DAY_ROW_ORDER.map((row) => (
            <div key={`row-${row.dayOfWeek}`} className="contents">
              <div className="h-6 flex items-center pr-1 justify-end font-medium">
                {row.label}
              </div>
              {HOURS.map((h) => {
                const cell = cellByKey.get(`${row.dayOfWeek}-${h}`);
                const count = cell?.trip_count ?? 0;
                const bg = cellColor(count, maxCount, dark);
                const label = `${FULL_DAY_LABEL[row.dayOfWeek]} at ${formatHour(h)}`;
                const title = `${label}: ${count.toLocaleString()} trips${
                  cell ? ` · $${cell.avg_fare} avg fare` : ""
                }`;
                return (
                  <button
                    key={`c-${row.dayOfWeek}-${h}`}
                    type="button"
                    title={title}
                    aria-label={title}
                    disabled={!onCellClick || count === 0}
                    onClick={() => {
                      if (!cell) return;
                      onCellClick?.(label, cell);
                    }}
                    className="h-6 rounded-[3px] transition-all hover:ring-2 hover:ring-primary/50 hover:scale-[1.08] disabled:cursor-default disabled:hover:ring-0 disabled:hover:scale-100"
                    style={{ backgroundColor: bg }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3 text-[10px] text-muted-foreground/80">
        <span>fewer</span>
        <div className="flex gap-[2px]">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <div
              key={`legend-${t}`}
              className="h-3 w-4 rounded-[2px]"
              style={{
                backgroundColor: cellColor(
                  Math.round(maxCount * t),
                  maxCount || 1,
                  dark,
                ),
              }}
            />
          ))}
        </div>
        <span>more</span>
        {maxCount > 0 && (
          <span className="ml-2">
            peak {maxCount.toLocaleString()} trips/slot
          </span>
        )}
      </div>
    </div>
  );
}
