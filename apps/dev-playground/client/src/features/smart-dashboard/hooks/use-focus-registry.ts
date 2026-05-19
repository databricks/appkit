import { useEffect, useRef, useState } from "react";

/**
 * Module-level focus registry. Chart wrappers register a callback under a
 * stable id; `focusChart(id)` looks up the callback and invokes it to
 * scroll the user's viewport to the chart and pulse a ring around it.
 *
 * Registrations live outside React state so the agent's SSE stream (which
 * hands off to `focusChart` via `use-action-dispatcher`) never needs to
 * thread a ref through the component tree.
 */
const registry = new Map<string, () => void>();

export type FocusableChartId =
  | "kpis"
  | "trips_over_time"
  | "fare_distribution"
  | "hourly_heatmap"
  | "top_zones";

export const FOCUSABLE_CHART_IDS: FocusableChartId[] = [
  "kpis",
  "trips_over_time",
  "fare_distribution",
  "hourly_heatmap",
  "top_zones",
];

export function isFocusableChartId(id: unknown): id is FocusableChartId {
  return (
    typeof id === "string" &&
    (FOCUSABLE_CHART_IDS as readonly string[]).includes(id)
  );
}

export function focusChart(id: FocusableChartId): void {
  registry.get(id)?.();
}

/**
 * Registers `id` as a focusable chart. Returns a `setRef` callback for the
 * wrapping element and a `focused` boolean that flips true for 1.2s when
 * `focusChart(id)` is called from elsewhere.
 */
export function useFocusable(id: FocusableChartId): {
  setRef: (el: HTMLElement | null) => void;
  focused: boolean;
} {
  const elRef = useRef<HTMLElement | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const onFocus = (): void => {
      const el = elRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setFocused(true);
      setTimeout(() => setFocused(false), 1200);
    };
    registry.set(id, onFocus);
    return () => {
      if (registry.get(id) === onFocus) registry.delete(id);
    };
  }, [id]);

  const setRef = (el: HTMLElement | null): void => {
    elRef.current = el;
  };

  return { setRef, focused };
}
