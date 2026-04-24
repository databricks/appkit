import { sql } from "@databricks/appkit-ui/js";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { useMemo } from "react";

interface KPIRawRow {
  total_trips: number;
  avg_fare: number;
  avg_distance: number;
  max_fare: number;
  min_fare: number;
}

interface TopZoneData {
  pickup_zip: string;
  trip_count: number;
}

export type KPIData = KPIRawRow & {
  top_pickup_zone: string;
  top_zone_trips: number;
};

export interface TripOverTime {
  trip_date: string;
  trip_count: number;
  avg_fare: number;
  total_revenue: number;
}

export interface FareBucket {
  fare_bucket: string;
  trip_count: number;
  avg_distance: number;
}

export interface HeatmapCell {
  day_of_week: number;
  hour_of_day: number;
  trip_count: number;
  avg_fare: number;
}

export interface TopZoneRow {
  pickup_zip: string;
  trip_count: number;
  total_revenue: number;
  avg_fare: number;
}

export interface SparklineRow {
  trip_date: string;
  trip_count: number;
  total_revenue: number;
  avg_fare: number;
  avg_distance: number;
}

export interface DashboardFilters {
  date_from?: string;
  date_to?: string;
  pickup_zip?: string;
  fare_min?: string;
  fare_max?: string;
}

function buildParams(filters: DashboardFilters) {
  return {
    dateFrom: sql.string(filters.date_from ?? "all"),
    dateTo: sql.string(filters.date_to ?? "all"),
    pickupZip: sql.string(filters.pickup_zip ?? "all"),
    fareMin: sql.string(filters.fare_min ?? "all"),
    fareMax: sql.string(filters.fare_max ?? "all"),
  };
}

export function useDashboardData(filters: DashboardFilters) {
  const params = useMemo(() => buildParams(filters), [filters]);

  const {
    data: kpisRaw,
    loading: kpisLoading,
    error: kpisError,
  } = useAnalyticsQuery("dashboard_kpis", params) as {
    data: KPIRawRow[] | null;
    loading: boolean;
    error: string | null;
  };

  const {
    data: topZoneRaw,
    loading: topZoneLoading,
    error: topZoneError,
  } = useAnalyticsQuery("dashboard_top_zone", params) as {
    data: TopZoneData[] | null;
    loading: boolean;
    error: string | null;
  };

  const tripsParams = useMemo(
    () => ({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      pickupZip: params.pickupZip,
    }),
    [params.dateFrom, params.dateTo, params.pickupZip],
  );

  const {
    data: tripsOverTime,
    loading: tripsLoading,
    error: tripsError,
  } = useAnalyticsQuery("dashboard_trips_over_time", tripsParams) as {
    data: TripOverTime[] | null;
    loading: boolean;
    error: string | null;
  };

  const {
    data: fareDistribution,
    loading: fareLoading,
    error: fareError,
  } = useAnalyticsQuery("dashboard_fare_distribution", tripsParams) as {
    data: FareBucket[] | null;
    loading: boolean;
    error: string | null;
  };

  const {
    data: heatmap,
    loading: heatmapLoading,
    error: heatmapError,
  } = useAnalyticsQuery("dashboard_hourly_heatmap", params) as {
    data: HeatmapCell[] | null;
    loading: boolean;
    error: string | null;
  };

  const {
    data: topZones,
    loading: topZonesLoading,
    error: topZonesError,
  } = useAnalyticsQuery("dashboard_top_zones", params) as {
    data: TopZoneRow[] | null;
    loading: boolean;
    error: string | null;
  };

  const {
    data: sparklines,
    loading: sparklinesLoading,
    error: sparklinesError,
  } = useAnalyticsQuery("dashboard_kpi_sparklines", params) as {
    data: SparklineRow[] | null;
    loading: boolean;
    error: string | null;
  };

  const kpis = useMemo(() => {
    if (!kpisRaw || kpisRaw.length === 0) return null;
    const row = kpisRaw[0];
    const topZone = topZoneRaw?.[0];
    return {
      ...row,
      top_pickup_zone: topZone?.pickup_zip ?? "N/A",
      top_zone_trips: topZone?.trip_count ?? 0,
    };
  }, [kpisRaw, topZoneRaw]);

  const isLoading =
    kpisLoading ||
    topZoneLoading ||
    tripsLoading ||
    fareLoading ||
    heatmapLoading ||
    topZonesLoading ||
    sparklinesLoading;
  const error =
    kpisError ||
    topZoneError ||
    tripsError ||
    fareError ||
    heatmapError ||
    topZonesError ||
    sparklinesError;

  return {
    kpis,
    tripsOverTime: tripsOverTime ?? [],
    fareDistribution: fareDistribution ?? [],
    heatmap: heatmap ?? [],
    topZones: topZones ?? [],
    sparklines: sparklines ?? [],
    isLoading,
    error,
  };
}
