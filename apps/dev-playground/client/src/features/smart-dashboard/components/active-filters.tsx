import { FilterIcon, XIcon } from "lucide-react";
import type { DashboardFilters } from "../hooks/use-dashboard-data";

interface ActiveFiltersProps {
  filters: DashboardFilters;
  onClear: (key: keyof DashboardFilters) => void;
  onClearAll: () => void;
}

function formatFilterEntry(key: string, value: string): string {
  const labels: Record<string, string> = {
    date_from: "From",
    date_to: "To",
    pickup_zip: "Zone",
    fare_min: "Min fare",
    fare_max: "Max fare",
  };
  return `${labels[key] ?? key}: ${value}`;
}

export function ActiveFilters({
  filters,
  onClear,
  onClearAll,
}: ActiveFiltersProps) {
  const entries = Object.entries(filters).filter(
    ([, v]) => v !== undefined && v !== "",
  );

  if (entries.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap rounded-lg border border-border bg-card px-3 py-2">
      <FilterIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs font-medium text-muted-foreground">
        Active Filters:
      </span>
      {entries.map(([key, value]) => (
        <span
          key={key}
          className="inline-flex items-center gap-1 rounded-md bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium"
        >
          {formatFilterEntry(key, value ?? "")}
          <button
            type="button"
            onClick={() => onClear(key as keyof DashboardFilters)}
            className="hover:text-primary/70 transition-colors"
            aria-label={`Remove ${key} filter`}
          >
            <XIcon className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
      >
        Clear all
      </button>
    </div>
  );
}
