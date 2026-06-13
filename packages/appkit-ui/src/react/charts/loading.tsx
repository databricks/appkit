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
 * Non-shimmery placeholder for cold-starting backing resources. Use this
 * over {@link LoadingSkeleton} when `useChartData` reports a non-null
 * `warehouseStatus` — a shimmer during a 30s–2min wait is misleading.
 * The global {@link ResourceStatusIndicator} surfaces the "why".
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
