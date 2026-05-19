import type { Highlight } from "../hooks/use-action-dispatcher";
import type { DashboardFilters } from "../hooks/use-dashboard-data";

/**
 * Serialises the user's current dashboard state into a short natural-language
 * preamble prepended to every chat turn. The `query` dispatcher and its
 * specialists use this to stay grounded in what the user is looking at —
 * e.g. "user asked 'is this unusual?' with filters {date_from: 2016-11-01}".
 *
 * Empty when nothing is set; callers should skip prepending in that case.
 */
export function buildDashboardContext(
  filters: DashboardFilters,
  highlights: Highlight[],
): string {
  const parts: string[] = [];

  const filterEntries = Object.entries(filters).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  if (filterEntries.length > 0) {
    const rendered = filterEntries
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    parts.push(`active filters: ${rendered}`);
  }

  if (highlights.length > 0) {
    const rendered = highlights
      .map(
        (h) =>
          `${h.start}..${h.end}${h.color !== "blue" ? ` [${h.color}]` : ""}${h.label ? ` (${h.label})` : ""}`,
      )
      .join("; ");
    parts.push(`highlighted periods: ${rendered}`);
  }

  if (parts.length === 0) return "";

  return `[Dashboard state] ${parts.join(". ")}.\n\nUser question: `;
}
