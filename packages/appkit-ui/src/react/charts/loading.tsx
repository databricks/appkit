import { Loader2Icon } from "lucide-react";

export function LoadingSkeleton({
  height = 300,
}: {
  height?: number | string;
}) {
  return (
    <div className="w-full animate-pulse bg-muted rounded" style={{ height }} />
  );
}

/**
 * Quiet placeholder shown while the chart is *waiting on a backing resource*
 * (e.g. a SQL warehouse cold-starting) rather than waiting on the SQL query
 * itself. Deliberately non-shimmery so the user understands the system is
 * stalled, not "any second now".
 *
 * Consumers typically prefer this over {@link LoadingSkeleton} when
 * `useAnalyticsQuery`/`useChartData` reports a non-null `warehouseStatus`,
 * because a shimmering skeleton during a 30s–2min cold start is misleading.
 * The {@link ResourceStatusIndicator} handles the global "why" affordance.
 */
export function ResourceWaitingPlaceholder({
  height = 300,
  message = "Waiting for warehouse…",
}: {
  height?: number | string;
  message?: string;
}) {
  return (
    <output
      className="w-full rounded border border-dashed border-border/60 bg-muted/30 flex items-center justify-center text-muted-foreground"
      style={{ height }}
      aria-live="polite"
    >
      <span className="flex items-center gap-2 text-xs">
        <Loader2Icon className="h-3.5 w-3.5 animate-spin opacity-60" />
        <span>{message}</span>
      </span>
    </output>
  );
}
