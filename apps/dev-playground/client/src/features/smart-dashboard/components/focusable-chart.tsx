import type { ReactNode } from "react";
import {
  type FocusableChartId,
  useFocusable,
} from "../hooks/use-focus-registry";

interface FocusableChartProps {
  chartId: FocusableChartId;
  children: ReactNode;
}

/**
 * Wraps a chart with a focus-ring pulse effect. Pairs with `focusChart(id)`
 * — when the `dashboard_pilot` agent emits a `focus_chart({ chart_id })`
 * tool call, the dispatcher invokes the registered callback here, which
 * scrolls into view and flips `focused` true for 1.2s.
 *
 * Named `chartId` (not `id`) because this is a logical focus-registry key,
 * not a DOM id attribute.
 */
export function FocusableChart({ chartId, children }: FocusableChartProps) {
  const { setRef, focused } = useFocusable(chartId);

  return (
    <div
      ref={setRef}
      className={`rounded-xl transition-[box-shadow,transform] duration-500 ${
        focused
          ? "ring-4 ring-primary ring-offset-2 ring-offset-background scale-[1.01]"
          : ""
      }`}
    >
      {children}
    </div>
  );
}
