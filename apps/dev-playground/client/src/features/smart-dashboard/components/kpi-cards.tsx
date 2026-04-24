import { CarIcon, DollarSignIcon, MapPinIcon, RulerIcon } from "lucide-react";
import type { KPIData } from "../hooks/use-dashboard-data";

interface KPICardsProps {
  data: KPIData | null;
  isLoading: boolean;
}

interface CardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  isLoading: boolean;
}

function KPICard({ title, value, subtitle, icon, isLoading }: CardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-muted-foreground">
          {title}
        </span>
        <span className="text-muted-foreground/60">{icon}</span>
      </div>
      {isLoading ? (
        <div className="h-8 w-24 animate-pulse rounded bg-muted" />
      ) : (
        <>
          <p className="text-2xl font-bold text-foreground">{value}</p>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
          )}
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

export function KPICards({ data, isLoading }: KPICardsProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <KPICard
        title="Total Trips"
        value={data ? formatNumber(data.total_trips) : "--"}
        icon={<CarIcon className="h-5 w-5" />}
        isLoading={isLoading}
      />
      <KPICard
        title="Avg Fare"
        value={data ? `$${data.avg_fare}` : "--"}
        subtitle={
          data ? `Range: $${data.min_fare} - $${data.max_fare}` : undefined
        }
        icon={<DollarSignIcon className="h-5 w-5" />}
        isLoading={isLoading}
      />
      <KPICard
        title="Avg Distance"
        value={data ? `${data.avg_distance} mi` : "--"}
        icon={<RulerIcon className="h-5 w-5" />}
        isLoading={isLoading}
      />
      <KPICard
        title="Top Pickup Zone"
        value={data?.top_pickup_zone ?? "--"}
        subtitle={
          data ? `${formatNumber(data.top_zone_trips)} trips` : undefined
        }
        icon={<MapPinIcon className="h-5 w-5" />}
        isLoading={isLoading}
      />
    </div>
  );
}
