import { createAgent, tool } from "@databricks/appkit/beta";
import { z } from "zod";

// Smart-Dashboard pilot: emits UI-action tool calls the client applies to the
// dashboard. A sub-agent of the markdown `query` dispatcher.
//
// Narrow, single-purpose tools.
//
// The earlier polymorphic `apply_filter({ field, operator, value })` was
// too expressive — the LLM could emit valid-looking calls the dispatcher
// couldn't faithfully apply (e.g. `field: "dropoff_zone"` when the
// dashboard only has a `pickup_zip` filter; `operator: "eq"` with a date).
// Splitting into one tool per filter verb removes the whole class of
// "agent said it worked but nothing moved" bugs.
//
// Each tool has exactly one client-side effect, rendered by
// use-action-dispatcher. Server handlers are still stubs — the tool-call
// JSON is the action payload.

const filter_by_date_range = tool({
  name: "filter_by_date_range",
  description:
    "Filter the dashboard to trips within a date range. Both start and end are required and must be ISO dates (YYYY-MM-DD) within 2016.",
  schema: z.object({
    start: z.string().describe("Start date in ISO format, e.g. 2016-03-01"),
    end: z.string().describe("End date in ISO format, e.g. 2016-03-31"),
  }),
  execute: async ({ start, end }) =>
    `Filtered dashboard to trips between ${start} and ${end}.`,
});

const filter_by_pickup_zip = tool({
  name: "filter_by_pickup_zip",
  description:
    "Filter the dashboard to trips originating from a specific pickup ZIP code. Use when the user asks about a specific pickup zone or ZIP.",
  schema: z.object({
    zip: z.string().describe("Pickup ZIP code, e.g. 10001"),
  }),
  execute: async ({ zip }) =>
    `Filtered dashboard to trips picked up in ${zip}.`,
});

const filter_by_fare = tool({
  name: "filter_by_fare",
  description:
    "Filter the dashboard to trips within a fare range. At least one of min or max must be provided.",
  schema: z
    .object({
      min: z.number().optional().describe("Minimum fare in USD"),
      max: z.number().optional().describe("Maximum fare in USD"),
    })
    .refine((v) => v.min !== undefined || v.max !== undefined, {
      message: "Provide at least one of min or max.",
    }),
  execute: async ({ min, max }) => {
    const parts = [] as string[];
    if (min !== undefined) parts.push(`>= $${min}`);
    if (max !== undefined) parts.push(`<= $${max}`);
    return `Filtered dashboard to trips with fare ${parts.join(" and ")}.`;
  },
});

const clear_filters = tool({
  name: "clear_filters",
  description:
    "Remove all active filters from the dashboard. Use when the user asks to reset, clear, or remove filters.",
  schema: z.object({}),
  execute: async () => "All filters cleared.",
});

const highlight_period = tool({
  name: "highlight_period",
  description:
    "Highlight a time period on the Trips Over Time chart to draw attention to a specific date range.",
  schema: z.object({
    start: z.string().describe("Start date in ISO format (YYYY-MM-DD)"),
    end: z.string().describe("End date in ISO format (YYYY-MM-DD)"),
    color: z
      .enum(["blue", "red", "yellow"])
      .optional()
      .describe("Highlight color. Defaults to blue."),
    label: z
      .string()
      .optional()
      .describe("Optional label for the highlighted period"),
  }),
  execute: async ({ start, end, color: _color, label }) => {
    const suffix = label ? ` (${label})` : "";
    return `Highlighted period ${start} to ${end}${suffix} on the dashboard.`;
  },
});

const clear_highlights = tool({
  name: "clear_highlights",
  description:
    "Remove all highlight overlays from the charts. Use when the user asks to clear, reset, or remove highlights.",
  schema: z.object({}),
  execute: async () => "All highlights cleared.",
});

// Restores a previously saved view. The tool-call arguments are the
// authoritative state: the client listens for this function_call on SSE
// and applies the filters + highlights directly without needing a round
// trip back for metadata. The agent is expected to have looked up the
// saved view server-side before emitting this call (it passes the
// already-resolved state through).
const load_view = tool({
  name: "load_view",
  description:
    "Restore a previously saved dashboard view by applying its filters and highlights. The caller supplies the already-resolved state so the client can apply it from this tool call without a second round trip.",
  schema: z.object({
    name: z.string().describe("The saved view's name (for UI feedback)"),
    filters: z
      .object({
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        pickup_zip: z.string().optional(),
        fare_min: z.string().optional(),
        fare_max: z.string().optional(),
      })
      .passthrough()
      .describe("Filters to restore. Omit fields that should not be set."),
    highlights: z
      .array(
        z.object({
          start: z.string(),
          end: z.string(),
          color: z.enum(["blue", "red", "yellow"]).optional(),
          label: z.string().optional(),
        }),
      )
      .describe("Highlight ranges to restore."),
  }),
  execute: async ({ name }) => `Restored saved view "${name}".`,
});

const focus_chart = tool({
  name: "focus_chart",
  description:
    "Scroll the user's viewport to a specific chart on the dashboard and briefly pulse it to draw attention. Use when the user asks to 'look at' or 'focus on' a specific visualization.",
  schema: z.object({
    chart_id: z
      .enum([
        "kpis",
        "trips_over_time",
        "fare_distribution",
        "hourly_heatmap",
        "top_zones",
      ])
      .describe("Which chart to focus on"),
  }),
  execute: async ({ chart_id }) => `Focused on ${chart_id}.`,
});

const highlight_zone = tool({
  name: "highlight_zone",
  description:
    "Draw an emphasis ring around a specific pickup ZIP on the Top Pickup Zones chart. Use this to call attention to a standout zone without filtering the whole dashboard to that ZIP.",
  schema: z.object({
    zip: z.string().describe("Pickup ZIP code to highlight (e.g. '10017')"),
    label: z
      .string()
      .optional()
      .describe("Optional short label shown inside the highlighted bar"),
  }),
  execute: async ({ zip, label }) =>
    `Highlighted pickup ZIP ${zip}${label ? ` (${label})` : ""}.`,
});

const clear_zone_highlights = tool({
  name: "clear_zone_highlights",
  description: "Remove all emphasis rings from the Top Pickup Zones chart.",
  schema: z.object({}),
  execute: async () => "Zone highlights cleared.",
});

// Write tool: exercises the approval gate. Server handler is a stub —
// no view persistence — but `effect: "write"` forces the human-in-the-loop
// flow before the agent can call it. We pick `write` (not `destructive`)
// because capturing a view CREATES a new file; nothing is deleted or
// overwritten. The approval card will render the low-severity blue
// "writes" treatment rather than the alarming red "destructive" one.
const save_view = tool({
  name: "save_view",
  description:
    "Persist the current dashboard configuration (filters + highlights) as a named view the user can recall later. Always surfaces the approval gate as a write action.",
  annotations: { effect: "write" },
  schema: z.object({
    name: z.string().describe("Short human-readable name for the saved view"),
    description: z
      .string()
      .optional()
      .describe("Optional longer description for the saved view"),
  }),
  execute: async ({ name, description }) => {
    const suffix = description ? `: ${description}` : "";
    return `Saved view "${name}"${suffix}.`;
  },
});

export default createAgent({
  instructions: [
    "You are the Smart Dashboard pilot. You do not query data — you manipulate the UI.",
    "Filters:",
    "- `filter_by_date_range({start, end})` — narrow to a date window within 2016.",
    "- `filter_by_pickup_zip({zip})` — narrow to trips from a specific ZIP.",
    "- `filter_by_fare({min?, max?})` — narrow by fare range (at least one bound required).",
    "- `clear_filters()` — remove all active filters.",
    "Highlights:",
    "- `highlight_period({start, end, color?, label?})` — shade a date window on the Trips Over Time chart.",
    "- `clear_highlights()` — remove all shaded overlays from the trips chart.",
    "- `highlight_zone({zip, label?})` — draw an emphasis ring around a specific ZIP on the Top Pickup Zones chart.",
    "- `clear_zone_highlights()` — remove all ZIP emphasis rings.",
    "Focus & save:",
    "- `focus_chart({chart_id})` — scroll the viewport to one of `kpis`, `trips_over_time`, `fare_distribution`, `hourly_heatmap`, `top_zones` and briefly pulse it.",
    "- `save_view({name, description?})` — persist the current configuration. Write action; the user will see an approval card.",
    "- `load_view({name, filters, highlights})` — restore a previously saved view. Always pass the resolved state; never leave fields unset.",
    "Rules:",
    "1. Pick the single tool that matches the user's intent. Do not chain filters unless the user asks for a compound filter.",
    "2. Briefly state what you did after the tool returns. Do not narrate before calling the tool.",
    "3. If the user's request is ambiguous (e.g. 'filter to last month' without a 2016 context), ask one clarifying question before calling any tool.",
    "4. For standout ZIPs, prefer `highlight_zone` over `filter_by_pickup_zip` so the rest of the dashboard stays in context. Only filter when the user explicitly asks to narrow the whole dashboard.",
  ].join("\n"),
  tools: {
    filter_by_date_range,
    filter_by_pickup_zip,
    filter_by_fare,
    clear_filters,
    highlight_period,
    clear_highlights,
    highlight_zone,
    clear_zone_highlights,
    focus_chart,
    save_view,
    load_view,
  },
});
