import "reflect-metadata";
import {
  agents,
  analytics,
  createAgent,
  createApp,
  type FilePolicy,
  files,
  fromPlugin,
  genie,
  jobs,
  PolicyDeniedError,
  server,
  serving,
  tool,
  WRITE_ACTIONS,
} from "@databricks/appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { z } from "zod";
import { lakebaseExamples } from "./lakebase-examples-plugin";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

function createMockClient() {
  const client = new WorkspaceClient({
    host: "http://localhost",
    token: "e2e",
    authType: "pat",
  });
  client.currentUser.me = async () => ({ id: "e2e-test-user" });
  return client;
}

/**
 * Policy test harness.
 *
 * Each volume key below is backed by a `DATABRICKS_VOLUME_*` env var in
 * `app.yaml` — all seven point at the same underlying UC volume path.
 * The different policies are evaluated in-process, so the shared path
 * is fine; the logical volume key is what drives enforcement.
 *
 * Exercises every policy shape the plugin ships with, plus the new
 * "no policy configured" default (v0.21.0+).
 */
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? "";

/** Writes allowed only for the configured admin user ID; reads open. */
const adminOnly: FilePolicy = (action, _resource, user) => {
  if (WRITE_ACTIONS.has(action)) {
    return ADMIN_USER_ID !== "" && user.id === ADMIN_USER_ID;
  }
  return true;
};

// Code-defined demo agent showing the fromPlugin() API alongside the
// markdown-driven agents in config/agents/.
const helper = createAgent({
  instructions:
    "You are a demo helper. Use analytics tools to answer data questions, " +
    "or get_weather for light small-talk.",
  tools: {
    ...fromPlugin(analytics),
    get_weather: tool({
      name: "get_weather",
      description: "Get the current weather for a city",
      schema: z.object({ city: z.string().describe("City name") }),
      execute: async ({ city }) => `The weather in ${city} is sunny, 22°C`,
    }),
  },
});

/*
 * Smart-Dashboard agents.
 *
 * The three agents form a dispatcher pattern for the /smart-dashboard route.
 * The `query` agent (markdown, in config/agents/query/) routes user
 * questions to one of two specialists:
 *
 * - `sql_analyst` — writes Databricks SQL against `samples.nyctaxi.trips`
 *   using the analytics plugin's query tool.
 * - `dashboard_pilot` — emits UI-action tool calls (`apply_filter`,
 *   `highlight_period`) that the client reads off the SSE stream and
 *   translates into React state mutations. The server-side handlers are
 *   intentionally stubs — the tool-call JSON is the action payload.
 */

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

const focus_chart = tool({
  name: "focus_chart",
  description:
    "Scroll the user's viewport to a specific chart on the dashboard and briefly pulse it to draw attention. Use when the user asks to 'look at' or 'focus on' a specific visualization.",
  schema: z.object({
    chart_id: z
      .enum(["kpis", "trips_over_time", "fare_distribution"])
      .describe("Which chart to focus on"),
  }),
  execute: async ({ chart_id }) => `Focused on ${chart_id}.`,
});

// Destructive tool: exercises the approval gate. Server handler is a
// stub — no view persistence — but `destructive: true` forces the
// human-in-the-loop flow before the agent can call it.
const save_view = tool({
  name: "save_view",
  description:
    "Persist the current dashboard configuration (filters + highlights) as a named view the user can recall later. Destructive because it writes persistent user state; always surfaces the approval gate.",
  annotations: { destructive: true, readOnly: false },
  schema: z.object({
    name: z.string().describe("Short human-readable name for the saved view"),
    description: z
      .string()
      .optional()
      .describe("Optional longer description for the saved view"),
  }),
  execute: async ({ name, description }) => {
    const suffix = description ? `: ${description}` : "";
    // Stub for the demo. A real impl would insert into a views table.
    console.log(`[save_view] Saving view "${name}"${suffix}`);
    return `Saved view "${name}"${suffix}.`;
  },
});

const sql_analyst = createAgent({
  instructions: [
    "You are a SQL expert for NYC taxi trip data (`samples.nyctaxi.trips`).",
    "Write Databricks SQL to answer the user's question and summarize the results clearly.",
    "IMPORTANT: The dataset only contains trips from 2016. Always add `WHERE tpep_pickup_datetime >= '2016-01-01' AND tpep_pickup_datetime < '2017-01-01'` unless the user specifies a narrower date range within 2016.",
    "If the user asks about dates outside 2016, say the dataset only covers 2016.",
    "Available columns: tpep_pickup_datetime, tpep_dropoff_datetime, trip_distance, fare_amount, pickup_zip, dropoff_zip.",
  ].join(" "),
  tools: {
    ...fromPlugin(analytics),
  },
});

const dashboard_pilot = createAgent({
  instructions: [
    "You are the Smart Dashboard pilot. You do not query data — you manipulate the UI.",
    "Filters:",
    "- `filter_by_date_range({start, end})` — narrow to a date window within 2016.",
    "- `filter_by_pickup_zip({zip})` — narrow to trips from a specific ZIP.",
    "- `filter_by_fare({min?, max?})` — narrow by fare range (at least one bound required).",
    "- `clear_filters()` — remove all active filters.",
    "Highlights:",
    "- `highlight_period({start, end, color?, label?})` — shade a date window on the trips chart.",
    "- `clear_highlights()` — remove all shaded overlays.",
    "Focus & save:",
    "- `focus_chart({chart_id})` — scroll the viewport to `kpis`, `trips_over_time`, or `fare_distribution` and briefly pulse it.",
    "- `save_view({name, description?})` — persist the current configuration. Destructive; the user will see an approval card.",
    "Rules:",
    "1. Pick the single tool that matches the user's intent. Do not chain filters unless the user asks for a compound filter.",
    "2. Briefly state what you did after the tool returns. Do not narrate before calling the tool.",
    "3. If the user's request is ambiguous (e.g. 'filter to last month' without a 2016 context), ask one clarifying question before calling any tool.",
  ].join("\n"),
  tools: {
    filter_by_date_range,
    filter_by_pickup_zip,
    filter_by_fare,
    clear_filters,
    highlight_period,
    clear_highlights,
    focus_chart,
    save_view,
  },
});

createApp({
  plugins: [
    server(),
    reconnect(),
    telemetryExamples(),
    analytics({}),
    genie({
      spaces: { demo: process.env.DATABRICKS_GENIE_SPACE_ID ?? "placeholder" },
    }),
    lakebaseExamples(),
    files({
      volumes: {
        // baseline: everything allowed
        allow_all: { policy: files.policy.allowAll() },
        // read-only: uploads/mkdir/delete return 403
        public_read: { policy: files.policy.publicRead() },
        // locked: every action returns 403 (yes, even list)
        deny_all: { policy: files.policy.denyAll() },
        // SP can do everything, users can only read (docs example)
        sp_only: {
          policy: files.policy.any(
            (_action, _resource, user) => !!user.isServicePrincipal,
            files.policy.publicRead(),
          ),
        },
        // writes gated on ADMIN_USER_ID env var, reads open
        admin_only: { policy: adminOnly },
        // drop-box: writes only, reads denied (not(publicRead))
        write_only: { policy: files.policy.not(files.policy.publicRead()) },
        // no explicit policy → falls back to publicRead() + startup warning
        implicit: {},
      },
    }),
    jobs(),
    serving(),
    agents({
      agents: { helper, sql_analyst, dashboard_pilot },
      // `query` (markdown dispatcher) + `sql_analyst` + `dashboard_pilot`
      // wire the /smart-dashboard route. `insights` and `anomaly` are
      // ephemeral markdown agents auto-fired by the route's AgentSidebar.
    }),
    // TODO: re-enable once vector-search is exported from @databricks/appkit
    // vectorSearch({
    //   indexes: {
    //     demo: {
    //       indexName:
    //         process.env.DATABRICKS_VS_INDEX_NAME ?? "catalog.schema.index",
    //       columns: ["id", "text", "title"],
    //       queryType: "hybrid",
    //     },
    //   },
    // }),
  ],
  ...(process.env.APPKIT_E2E_TEST && { client: createMockClient() }),
  onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      app.get("/sp", (_req, res) => {
        appkit.analytics
          .query("SELECT * FROM samples.nyctaxi.trips;")
          .then((result) => {
            console.log(result[0]);
            res.json(result);
          })
          .catch((error) => {
            console.error("Error:", error);
            res.status(500).json({
              error: error.message,
              errorCode: error.errorCode,
              statusCode: error.statusCode,
            });
          });
      });

      app.get("/obo", (req, res) => {
        appkit.analytics
          .asUser(req)
          .query("SELECT * FROM samples.nyctaxi.trips;")
          .then((result) => {
            console.log(result[0]);
            res.json(result);
          })
          .catch((error) => {
            console.error("OBO Error:", error);
            res.status(500).json({
              error: error.message,
              errorCode: error.errorCode,
              statusCode: error.statusCode,
            });
          });
      });

      /**
       * Echoes the user identity the server sees. Useful for confirming
       * that `x-forwarded-user` is forwarded in the deployed environment.
       */
      app.get("/whoami", (req, res) => {
        res.json({
          xForwardedUser: req.header("x-forwarded-user") ?? null,
          adminUserId: ADMIN_USER_ID || null,
          isAdmin:
            ADMIN_USER_ID !== "" &&
            req.header("x-forwarded-user") === ADMIN_USER_ID,
        });
      });

      /**
       * Programmatic API smoke test — service principal path.
       *
       * All probes are read-only and deny-oriented, so nothing is
       * written to the UC volume. Expected results:
       * - `allow_all.list`      → ok (real SDK call)
       * - `deny_all.list`       → PolicyDeniedError (deny wins even for SP)
       * - `write_only.list`     → PolicyDeniedError (reads denied)
       *
       * Confirms `isServicePrincipal: true` is set on the SP path.
       */
      app.get("/policy/sp", async (_req, res) => {
        const results = await runProbes([
          ["allow_all", "list", () => appkit.files("allow_all").list()],
          ["deny_all", "list", () => appkit.files("deny_all").list()],
          ["write_only", "list", () => appkit.files("write_only").list()],
        ]);
        res.json({ identity: "service_principal", results });
      });

      /**
       * Programmatic API smoke test — OBO (on-behalf-of user) path.
       *
       * All probes are read-only; no files are written. Expected:
       * - `public_read.list` → ok (reads open)
       * - `deny_all.list`    → PolicyDeniedError
       * - `sp_only.list`     → ok (publicRead arm of `any()` allows reads)
       */
      app.get("/policy/obo", async (req, res) => {
        const results = await runProbes([
          [
            "public_read",
            "list",
            () => appkit.files("public_read").asUser(req).list(),
          ],
          [
            "deny_all",
            "list",
            () => appkit.files("deny_all").asUser(req).list(),
          ],
          ["sp_only", "list", () => appkit.files("sp_only").asUser(req).list()],
        ]);
        res.json({
          identity: "user",
          xForwardedUser: req.header("x-forwarded-user") ?? null,
          results,
        });
      });
    });
  },
}).catch(console.error);

type ProbeResult = {
  volume: string;
  action: string;
  ok: boolean;
  denied: boolean;
  error?: string;
};

async function runProbes(
  probes: Array<[string, string, () => Promise<unknown>]>,
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const [volume, action, fn] of probes) {
    try {
      await fn();
      out.push({ volume, action, ok: true, denied: false });
    } catch (error) {
      const denied = error instanceof PolicyDeniedError;
      out.push({
        volume,
        action,
        ok: false,
        denied,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}
