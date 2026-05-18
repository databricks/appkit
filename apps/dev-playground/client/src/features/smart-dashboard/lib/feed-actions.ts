import type { FocusableChartId } from "../hooks/use-focus-registry";

/**
 * Structured actions emitted by the `insights` and `anomaly` ephemeral
 * agents. Each kind maps 1:1 to a dispatcher tool (`filter_by_*`,
 * `highlight_*`, `focus_chart`) except `ask`, which flows through the main
 * chat dispatcher with a preloaded prompt.
 *
 * Kept in a neutral shape (not the wire tool-call format) so the agent can
 * hand-author JSON without memorising `call_id` / `arguments` envelopes,
 * and so the UI can render distinct copy per action kind.
 */

export interface FilterDateAction {
  kind: "filter_date";
  label: string;
  start: string;
  end: string;
}

export interface FilterZipAction {
  kind: "filter_zip";
  label: string;
  zip: string;
}

export interface FilterFareAction {
  kind: "filter_fare";
  label: string;
  min?: number;
  max?: number;
}

export interface HighlightPeriodAction {
  kind: "highlight_period";
  label: string;
  start: string;
  end: string;
  color?: "blue" | "red" | "yellow";
}

export interface HighlightZoneAction {
  kind: "highlight_zone";
  label: string;
  zip: string;
  note?: string;
}

export interface FocusChartAction {
  kind: "focus_chart";
  label: string;
  chart_id: FocusableChartId;
}

export interface AskAction {
  kind: "ask";
  label: string;
  prompt: string;
}

export type FeedAction =
  | FilterDateAction
  | FilterZipAction
  | FilterFareAction
  | HighlightPeriodAction
  | HighlightZoneAction
  | FocusChartAction
  | AskAction;

export interface FeedInsight {
  title: string;
  description: string;
  actions?: FeedAction[];
}

export interface FeedAnomaly extends FeedInsight {
  severity: "low" | "medium" | "high";
}

function isValidColor(v: unknown): v is "blue" | "red" | "yellow" {
  return v === "blue" || v === "red" || v === "yellow";
}

function isValidChartId(v: unknown): v is FocusableChartId {
  return (
    v === "kpis" ||
    v === "trips_over_time" ||
    v === "fare_distribution" ||
    v === "hourly_heatmap" ||
    v === "top_zones"
  );
}

function parseAction(raw: unknown): FeedAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  const label = typeof r.label === "string" ? r.label : "";
  if (!label) return null;

  switch (kind) {
    case "filter_date":
      if (typeof r.start === "string" && typeof r.end === "string") {
        return { kind, label, start: r.start, end: r.end };
      }
      return null;
    case "filter_zip":
      if (typeof r.zip === "string" && r.zip) {
        return { kind, label, zip: r.zip };
      }
      return null;
    case "filter_fare": {
      const min = typeof r.min === "number" ? r.min : undefined;
      const max = typeof r.max === "number" ? r.max : undefined;
      if (min === undefined && max === undefined) return null;
      return { kind, label, min, max };
    }
    case "highlight_period":
      if (typeof r.start === "string" && typeof r.end === "string") {
        return {
          kind,
          label,
          start: r.start,
          end: r.end,
          color: isValidColor(r.color) ? r.color : "blue",
        };
      }
      return null;
    case "highlight_zone":
      if (typeof r.zip === "string" && r.zip) {
        return {
          kind,
          label,
          zip: r.zip,
          ...(typeof r.note === "string" && r.note ? { note: r.note } : {}),
        };
      }
      return null;
    case "focus_chart":
      if (isValidChartId(r.chart_id)) {
        return { kind, label, chart_id: r.chart_id };
      }
      return null;
    case "ask":
      if (typeof r.prompt === "string" && r.prompt) {
        return { kind, label, prompt: r.prompt };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Extracts the first JSON array from an agent response and validates each
 * element as {@link FeedInsight}. Ignores malformed entries rather than
 * throwing — the agent is a Gemini flash model and occasionally wraps the
 * output in fences or adds an extra element with a different shape.
 */
export function parseFeedInsights(content: string): FeedInsight[] {
  return parseFeedPayload<FeedInsight>(content, (obj) => ({
    title: typeof obj.title === "string" ? obj.title : "",
    description: typeof obj.description === "string" ? obj.description : "",
    actions: Array.isArray(obj.actions)
      ? (obj.actions.map(parseAction).filter(Boolean) as FeedAction[])
      : undefined,
  }));
}

export function parseFeedAnomalies(content: string): FeedAnomaly[] {
  return parseFeedPayload<FeedAnomaly>(content, (obj) => {
    const severity =
      obj.severity === "low" ||
      obj.severity === "medium" ||
      obj.severity === "high"
        ? obj.severity
        : "low";
    return {
      title: typeof obj.title === "string" ? obj.title : "",
      description: typeof obj.description === "string" ? obj.description : "",
      severity,
      actions: Array.isArray(obj.actions)
        ? (obj.actions.map(parseAction).filter(Boolean) as FeedAction[])
        : undefined,
    };
  });
}

function parseFeedPayload<T extends FeedInsight>(
  content: string,
  builder: (obj: Record<string, unknown>) => T,
): T[] {
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((el) => {
      if (typeof el !== "object" || el === null) return [];
      const item = builder(el as Record<string, unknown>);
      return item.title ? [item] : [];
    });
  } catch {
    return [];
  }
}
