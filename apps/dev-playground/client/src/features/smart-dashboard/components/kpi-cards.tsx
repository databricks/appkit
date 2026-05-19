import { CarIcon, DollarSignIcon, MapPinIcon, RulerIcon } from "lucide-react";
import { useId, useMemo } from "react";
import { useChartColors } from "../hooks/use-chart-colors";
import type { KPIData, SparklineRow } from "../hooks/use-dashboard-data";

interface KPICardsProps {
  data: KPIData | null;
  sparklines: SparklineRow[];
  isLoading: boolean;
}

interface CardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  isLoading: boolean;
  /** 30-bar trailing series (or empty → no sparkline). Values are normalized inside. */
  series: number[];
  trend?: number;
}

/**
 * Fixed-size inline sparkline. Using a hand-rolled SVG rather than recharts
 * because:
 *  - recharts inside a grid of 4 cards would mount 4× chart engines with
 *    ResponsiveContainer observers — heavy for a decorative element;
 *  - we want sub-pixel control over the baseline tint + end-cap dot.
 */
function Sparkline({
  values,
  color,
  isLoading,
}: {
  values: number[];
  color: string;
  isLoading: boolean;
}) {
  const gradientId = useId();
  const width = 120;
  const height = 36;

  const { pathD, areaD, lastPoint } = useMemo(() => {
    if (values.length === 0) {
      return { pathD: "", areaD: "", lastPoint: null };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const step = values.length > 1 ? width / (values.length - 1) : width;
    const points = values.map((v, i) => {
      const x = i * step;
      const y = height - 4 - ((v - min) / span) * (height - 8);
      return { x, y };
    });
    const d = points
      .map(
        (p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`,
      )
      .join(" ");
    const area = `${d} L ${width} ${height} L 0 ${height} Z`;
    return { pathD: d, areaD: area, lastPoint: points[points.length - 1] };
  }, [values]);

  if (isLoading) {
    return <div className="h-[36px] w-full rounded bg-muted/40" />;
  }
  // Intentionally-empty series (e.g. categorical KPI like "Top Pickup Zone"):
  // keep the slot reserved so the four cards stay the same height, but render
  // nothing inside — otherwise the muted placeholder looks like a ghost
  // "still loading" spinner.
  if (values.length === 0) {
    return <div className="h-[36px] w-full" aria-hidden />;
  }

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="trend"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradientId})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.5} />
      {lastPoint && (
        <circle cx={lastPoint.x} cy={lastPoint.y} r={2.2} fill={color} />
      )}
    </svg>
  );
}

function KPICard({
  title,
  value,
  subtitle,
  icon,
  isLoading,
  series,
  trend,
}: CardProps) {
  const c = useChartColors();
  const trendLabel =
    trend === undefined
      ? null
      : trend > 0
        ? `+${trend.toFixed(0)}%`
        : `${trend.toFixed(0)}%`;
  const trendColor =
    trend === undefined
      ? ""
      : trend > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : trend < 0
          ? "text-rose-600 dark:text-rose-400"
          : "text-muted-foreground";

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </span>
        <span className="text-muted-foreground/60">{icon}</span>
      </div>
      {isLoading ? (
        <div className="h-8 w-24 animate-pulse rounded bg-muted" />
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold text-foreground">{value}</p>
            {trendLabel && (
              <span className={`text-[11px] font-medium ${trendColor}`}>
                {trendLabel}
              </span>
            )}
          </div>
          {subtitle && (
            <p
              className="text-xs text-muted-foreground mt-0.5 truncate"
              title={subtitle}
            >
              {subtitle}
            </p>
          )}
          <div className="mt-2 -mb-1 -mx-1">
            <Sparkline
              values={series}
              color={c.primary}
              isLoading={isLoading}
            />
          </div>
        </>
      )}
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Percent delta between the last `tail` window and the previous window. */
function windowedTrend(values: number[], tail: number): number | undefined {
  // Drop nulls/undefined/NaN (e.g. days with no trips after a fare filter) and
  // coerce everything to Number defensively — some drivers hand back DECIMAL
  // columns as strings, and `0 + "12.35"` would silently string-concat and
  // render "NaN%" once we tried to divide.
  const clean = values.map((v) => Number(v)).filter(Number.isFinite);
  if (clean.length < tail * 2) return undefined;
  const recent = clean.slice(-tail);
  const prior = clean.slice(-tail * 2, -tail);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!Number.isFinite(recentAvg) || !Number.isFinite(priorAvg))
    return undefined;
  if (priorAvg === 0) return undefined;
  return ((recentAvg - priorAvg) / priorAvg) * 100;
}

export function KPICards({ data, sparklines, isLoading }: KPICardsProps) {
  // Coerce on intake so downstream sparkline paths and trend math stay purely
  // numeric — avoids surprises if a driver ever hands back DECIMAL-as-string.
  const toNum = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const tripSeries = sparklines.map((r) => toNum(r.trip_count));
  const fareSeries = sparklines.map((r) => toNum(r.avg_fare));
  const distSeries = sparklines.map((r) => toNum(r.avg_distance));
  const revenueSeries = sparklines.map((r) => toNum(r.total_revenue));

  const TREND_WINDOW = 7;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <KPICard
        title="Total Trips"
        value={data ? formatNumber(data.total_trips) : "--"}
        icon={<CarIcon className="h-4 w-4" />}
        isLoading={isLoading}
        series={tripSeries}
        trend={windowedTrend(tripSeries, TREND_WINDOW)}
      />
      <KPICard
        title="Avg Fare"
        value={data ? `$${data.avg_fare}` : "--"}
        subtitle={
          data ? `Range: $${data.min_fare} – $${data.max_fare}` : undefined
        }
        icon={<DollarSignIcon className="h-4 w-4" />}
        isLoading={isLoading}
        series={fareSeries}
        trend={windowedTrend(fareSeries, TREND_WINDOW)}
      />
      <KPICard
        title="Avg Distance"
        value={data ? `${data.avg_distance} mi` : "--"}
        subtitle={
          revenueSeries.length > 0
            ? `$${formatNumber(
                // Explicit Number() wrap on each accumulator step defends
                // against a single stray string in the series silently
                // turning the whole sum into a concatenated blob.
                revenueSeries.reduce<number>(
                  (a, b) => a + (Number.isFinite(b) ? Number(b) : 0),
                  0,
                ),
              )} revenue`
            : undefined
        }
        icon={<RulerIcon className="h-4 w-4" />}
        isLoading={isLoading}
        series={distSeries}
        trend={windowedTrend(distSeries, TREND_WINDOW)}
      />
      <KPICard
        title="Top Pickup Zone"
        value={data?.top_pickup_zone ?? "--"}
        subtitle={
          data ? `${formatNumber(data.top_zone_trips)} trips` : undefined
        }
        icon={<MapPinIcon className="h-4 w-4" />}
        isLoading={isLoading}
        series={[]}
      />
    </div>
  );
}
