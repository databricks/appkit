import { useCallback } from "react";
import type { SSEEvent } from "./use-agent-stream";
import type { DashboardFilters } from "./use-dashboard-data";

export interface Highlight {
  start: string;
  end: string;
  color: "blue" | "red" | "yellow";
  label?: string;
}

const DASHBOARD_TOOLS = new Set(["apply_filter", "highlight_period"]);

interface UseActionDispatcherOptions {
  onFilterChange: (filters: DashboardFilters) => void;
  onHighlight: (highlight: Highlight) => void;
  currentFilters: DashboardFilters;
}

export function useActionDispatcher({
  onFilterChange,
  onHighlight,
  currentFilters,
}: UseActionDispatcherOptions) {
  const handleEvent = useCallback(
    (event: SSEEvent) => {
      if (
        event.type !== "response.output_item.added" &&
        event.type !== "response.output_item.done"
      )
        return;
      if (event.item?.type !== "function_call") return;

      const toolName = event.item.name;
      if (!toolName || !DASHBOARD_TOOLS.has(toolName)) return;

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(event.item.arguments ?? "{}");
      } catch {
        return;
      }

      if (toolName === "apply_filter") {
        const field = args.field as string;
        const operator = args.operator as string;
        const value = args.value as string | string[];

        const newFilters = { ...currentFilters };

        if (field === "date") {
          if (operator === "between" && Array.isArray(value)) {
            newFilters.date_from = value[0];
            newFilters.date_to = value[1];
          } else if (operator === "gt") {
            newFilters.date_from = value as string;
          } else if (operator === "lt") {
            newFilters.date_to = value as string;
          }
        } else if (field === "pickup_zone" || field === "dropoff_zone") {
          const zones = Array.isArray(value) ? value.join(",") : value;
          newFilters.pickup_zip = zones as string;
        } else if (field === "fare_range") {
          if (operator === "between" && Array.isArray(value)) {
            newFilters.fare_min = value[0];
            newFilters.fare_max = value[1];
          } else if (operator === "gt") {
            newFilters.fare_min = value as string;
          } else if (operator === "lt") {
            newFilters.fare_max = value as string;
          }
        }

        onFilterChange(newFilters);
      } else if (toolName === "highlight_period") {
        onHighlight({
          start: args.start as string,
          end: args.end as string,
          color: (args.color as Highlight["color"]) ?? "blue",
          label: args.label as string | undefined,
        });
      }
    },
    [onFilterChange, onHighlight, currentFilters],
  );

  return { handleEvent };
}
