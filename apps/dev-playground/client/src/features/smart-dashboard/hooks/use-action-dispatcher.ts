import { useCallback, useMemo, useRef } from "react";
import type { SSEEvent } from "./use-agent-stream";
import type { DashboardFilters } from "./use-dashboard-data";
import { focusChart, isFocusableChartId } from "./use-focus-registry";

export interface Highlight {
  start: string;
  end: string;
  color: "blue" | "red" | "yellow";
  label?: string;
}

export interface HighlightedZone {
  zip: string;
  label?: string;
}

const DASHBOARD_TOOLS = new Set<string>([
  "filter_by_date_range",
  "filter_by_pickup_zip",
  "filter_by_fare",
  "clear_filters",
  "highlight_period",
  "clear_highlights",
  "highlight_zone",
  "clear_zone_highlights",
  "focus_chart",
  "load_view",
]);

interface UseActionDispatcherOptions {
  /** Receives an updater fn; avoids stale-closure bugs when the agent fires multiple tool calls back-to-back. */
  onFilterUpdate: (
    updater: (prev: DashboardFilters) => DashboardFilters,
  ) => void;
  onAddHighlight: (highlight: Highlight) => void;
  onClearFilters: () => void;
  onClearHighlights: () => void;
  onAddZoneHighlight: (zone: HighlightedZone) => void;
  onClearZoneHighlights: () => void;
  /** Called once per applied action with a short human-readable summary. Route surfaces it as a toast. */
  onAction?: (summary: string) => void;
  /** Called when the dispatcher receives a tool it doesn't know how to handle. Lets the route warn visibly. */
  onUnknownTool?: (name: string, args: unknown) => void;
}

function parseArgs(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const CALL_ID_LRU_CAP = 128;

/**
 * Translates `function_call` tool events from the agent's SSE stream into
 * dashboard state mutations. Exposes the same per-tool mutations as a
 * synchronous {@link dispatch} function so the agent-feed action chips can
 * reuse the identical code path without going through an LLM round-trip.
 *
 * Correctness rules (learned the hard way):
 *
 * - Only acts on `response.output_item.done`, never `.added`. `.added` fires
 *   with incomplete `arguments`, causing spurious JSON parse failures and,
 *   worse, double-firing: `highlight_period` used to append the same band
 *   twice because both events passed.
 * - Dedupes by `call_id`. Keeps a bounded LRU so memory stays finite across
 *   a long session. A new run clears the cache on `appkit.metadata` (the
 *   first event of every stream carries the new threadId).
 * - Uses updater callbacks (`onFilterUpdate(prev => ...)`) instead of reading
 *   `currentFilters` from props. Multi-tool-call runs within a single
 *   render cycle would otherwise see stale filter state.
 * - Emits a summary for every applied action via `onAction`. Silent success
 *   is the worst failure mode here — if the user can't see what changed,
 *   they can't tell whether the agent misfired.
 */
export function useActionDispatcher(opts: UseActionDispatcherOptions) {
  const {
    onFilterUpdate,
    onAddHighlight,
    onClearFilters,
    onClearHighlights,
    onAddZoneHighlight,
    onClearZoneHighlights,
    onAction,
    onUnknownTool,
  } = opts;

  const seen = useRef<string[]>([]);

  const markSeen = useCallback((callId: string): boolean => {
    if (seen.current.includes(callId)) return true;
    seen.current.push(callId);
    if (seen.current.length > CALL_ID_LRU_CAP) {
      seen.current.splice(0, seen.current.length - CALL_ID_LRU_CAP);
    }
    return false;
  }, []);

  const dispatch = useCallback(
    (name: string, args: Record<string, unknown>): void => {
      if (!DASHBOARD_TOOLS.has(name)) {
        onUnknownTool?.(name, args);
        return;
      }

      switch (name) {
        case "filter_by_date_range": {
          const start = args.start;
          const end = args.end;
          if (typeof start !== "string" || typeof end !== "string") {
            onUnknownTool?.(name, args);
            return;
          }
          onFilterUpdate((prev) => ({
            ...prev,
            date_from: start,
            date_to: end,
          }));
          onAction?.(`Filtered to ${start} → ${end}`);
          return;
        }
        case "filter_by_pickup_zip": {
          const zip = args.zip;
          if (typeof zip !== "string") {
            onUnknownTool?.(name, args);
            return;
          }
          onFilterUpdate((prev) => ({ ...prev, pickup_zip: zip }));
          onAction?.(`Filtered to pickup ZIP ${zip}`);
          return;
        }
        case "filter_by_fare": {
          const min = typeof args.min === "number" ? args.min : undefined;
          const max = typeof args.max === "number" ? args.max : undefined;
          if (min === undefined && max === undefined) {
            onUnknownTool?.(name, args);
            return;
          }
          onFilterUpdate((prev) => ({
            ...prev,
            ...(min !== undefined ? { fare_min: String(min) } : {}),
            ...(max !== undefined ? { fare_max: String(max) } : {}),
          }));
          const parts: string[] = [];
          if (min !== undefined) parts.push(`≥ $${min}`);
          if (max !== undefined) parts.push(`≤ $${max}`);
          onAction?.(`Filtered by fare ${parts.join(" and ")}`);
          return;
        }
        case "clear_filters": {
          onClearFilters();
          onAction?.("Filters cleared");
          return;
        }
        case "highlight_period": {
          const start = args.start;
          const end = args.end;
          if (typeof start !== "string" || typeof end !== "string") {
            onUnknownTool?.(name, args);
            return;
          }
          const color =
            args.color === "red" || args.color === "yellow"
              ? args.color
              : "blue";
          const label =
            typeof args.label === "string" && args.label !== ""
              ? args.label
              : undefined;
          onAddHighlight({ start, end, color, label });
          onAction?.(
            `Highlighted ${start} → ${end}${label ? ` (${label})` : ""}`,
          );
          return;
        }
        case "clear_highlights": {
          onClearHighlights();
          onAction?.("Highlights cleared");
          return;
        }
        case "highlight_zone": {
          const zip = args.zip;
          if (typeof zip !== "string" || zip === "") {
            onUnknownTool?.(name, args);
            return;
          }
          const label =
            typeof args.label === "string" && args.label !== ""
              ? args.label
              : undefined;
          onAddZoneHighlight({ zip, label });
          onAction?.(`Highlighted ZIP ${zip}${label ? ` (${label})` : ""}`);
          return;
        }
        case "clear_zone_highlights": {
          onClearZoneHighlights();
          onAction?.("Zone highlights cleared");
          return;
        }
        case "focus_chart": {
          const id = args.chart_id;
          if (!isFocusableChartId(id)) {
            onUnknownTool?.(name, args);
            return;
          }
          focusChart(id);
          onAction?.(`Focused ${String(id).replace(/_/g, " ")}`);
          return;
        }
        case "load_view": {
          const rawFilters = (args.filters ?? {}) as Record<string, unknown>;
          const nextFilters: DashboardFilters = {};
          if (typeof rawFilters.date_from === "string")
            nextFilters.date_from = rawFilters.date_from;
          if (typeof rawFilters.date_to === "string")
            nextFilters.date_to = rawFilters.date_to;
          if (typeof rawFilters.pickup_zip === "string")
            nextFilters.pickup_zip = rawFilters.pickup_zip;
          if (typeof rawFilters.fare_min === "string")
            nextFilters.fare_min = rawFilters.fare_min;
          if (typeof rawFilters.fare_max === "string")
            nextFilters.fare_max = rawFilters.fare_max;

          const rawHighlights = Array.isArray(args.highlights)
            ? (args.highlights as Array<Record<string, unknown>>)
            : [];
          const nextHighlights: Highlight[] = rawHighlights.flatMap((h) => {
            const start = h.start;
            const end = h.end;
            if (typeof start !== "string" || typeof end !== "string") return [];
            const color: Highlight["color"] =
              h.color === "red" || h.color === "yellow" ? h.color : "blue";
            const label = typeof h.label === "string" ? h.label : undefined;
            return [{ start, end, color, label }];
          });

          // Restore: clear then re-apply both filters and highlights in one
          // shot so partial states don't linger.
          onClearFilters();
          onClearHighlights();
          onClearZoneHighlights();
          if (Object.keys(nextFilters).length > 0) {
            onFilterUpdate(() => nextFilters);
          }
          for (const h of nextHighlights) {
            onAddHighlight(h);
          }
          const viewName =
            typeof args.name === "string" ? args.name : "saved view";
          onAction?.(`Loaded "${viewName}"`);
          return;
        }
        default: {
          onUnknownTool?.(name, args);
          return;
        }
      }
    },
    [
      onFilterUpdate,
      onAddHighlight,
      onClearFilters,
      onClearHighlights,
      onAddZoneHighlight,
      onClearZoneHighlights,
      onAction,
      onUnknownTool,
    ],
  );

  const handleEvent = useCallback(
    (event: SSEEvent) => {
      if (event.type === "appkit.metadata") {
        seen.current = [];
        return;
      }

      if (event.type !== "response.output_item.done") return;
      if (event.item?.type !== "function_call") return;

      const name = event.item.name;
      if (!name) return;

      // Tools not owned by the dashboard (e.g. `analytics.query`, sub-agent
      // `agent-sql_analyst`) flow through without a dispatcher side-effect.
      if (!DASHBOARD_TOOLS.has(name)) return;

      const callId = event.item.call_id;
      if (callId && markSeen(callId)) return;

      const args = parseArgs(event.item.arguments);
      if (args === null) {
        onUnknownTool?.(name, event.item.arguments);
        return;
      }

      dispatch(name, args);
    },
    [dispatch, markSeen, onUnknownTool],
  );

  return useMemo(() => ({ handleEvent, dispatch }), [handleEvent, dispatch]);
}
